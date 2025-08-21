require('dotenv').config()

const express = require('express');
const cors = require('cors');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

// Use Firebase for persistent storage
const firebaseService = require('./firebaseService');

const callControlPath = '/call-control';
const callControlOutboundPath = `${callControlPath}/webhook`;
const webhookUrl = (new URL(callControlOutboundPath, process.env.BASE_URL)).href;

const callControl = require('./callControl');
const app = express();

// CORS handling FIRST - before any other middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    console.log('Preflight request:', req.path);
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(callControlPath, callControl);

// API endpoint for batch calls with Firebase storage
app.post('/api/make-call', async (req, res) => {
  try {
    const { phonenumber, contact_id, contact_name, content } = req.body;
    
    if (!phonenumber || !content) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number and content are required' 
      });
    }

    // Parse comma-separated values
    const phoneNumbers = phonenumber.split(',');
    const contactIds = contact_id ? contact_id.split(',') : [];
    const contactNames = contact_name ? contact_name.split(',') : [];
    const contents = Array.isArray(content) ? content : [content];

    const callSids = [];
    const broadcastId = `broadcast_${Date.now()}`;
    
    console.log(`Starting broadcast ${broadcastId} for ${phoneNumbers.length} numbers`);

    // Store broadcast session
    await firebaseService.storeBroadcastSession(broadcastId, {
      totalCalls: phoneNumbers.length,
      status: 'active',
      startTime: new Date()
    });

    const results = {
      successful: 0,
      failed: 0,
      errors: [],
      channelLimitHits: 0
    };

    for (let i = 0; i < phoneNumbers.length; i++) {
      const phone = phoneNumbers[i]?.trim();
      const contactId = contactIds[i]?.trim() || `contact_${i}`;
      const contactName = contactNames[i]?.trim() || `Contact ${i + 1}`;
      const script = contents[i] || contents[0]; // Use individual content or first one

      if (!phone) {
        console.log(`Skipping empty phone number at index ${i}`);
        results.failed++;
        continue;
      }

      console.log(`Processing call ${i + 1}/${phoneNumbers.length} for ${phone}`);

      try {
        const createCallRequest = {
          connection_id: process.env.TELNYX_CONNECTION_ID,
          to: phone,
          from: process.env.TELNYX_PHONE_NUMBER || '+18633049991',
          answering_machine_detection: "detect_words",
          webhook_url: webhookUrl
        };

        const { data: call } = await telnyx.calls.create(createCallRequest);
        const callControlId = call.call_control_id;
        
        callSids.push(callControlId);
        results.successful++;

        // Store call data in storage
        await firebaseService.storeCallData(callControlId, {
          callSid: callControlId,
          callLegId: call.call_leg_id,
          callSessionId: call.call_session_id,
          broadcastId: broadcastId,
          contactId: contactId,
          contactName: contactName,
          phoneNumber: phone,
          script: script,
          status: 'pending'
        });

        console.log(`✅ Created call ${results.successful} for ${phone}, call_control_id: ${callControlId}`);
        
        // Much longer delay between calls to respect very low channel limits
        if (i < phoneNumbers.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay between each call
        }

      } catch (error) {
        const errorMsg = error.response?.data?.errors?.[0]?.detail || error.message;
        const isChannelLimitError = errorMsg.includes('channel limit exceeded') || error.response?.status === 403;
        
        if (isChannelLimitError) {
          results.channelLimitHits++;
          
          // Dynamic wait time based on how many times we've hit the limit
          const waitTime = Math.min(15000 + (results.channelLimitHits * 5000), 60000); // 15s + 5s per hit, max 60s
          console.warn(`⚠️ Channel limit exceeded for ${phone} (hit #${results.channelLimitHits}), waiting ${waitTime/1000} seconds and retrying...`);
          
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          try {
            const retryRequest = {
              connection_id: process.env.TELNYX_CONNECTION_ID,
              to: phone,
              from: process.env.TELNYX_PHONE_NUMBER || '+18633049991',
              answering_machine_detection: "detect_words",
              webhook_url: webhookUrl
            };

            const { data: retryCall } = await telnyx.calls.create(retryRequest);
            const retryCallControlId = retryCall.call_control_id;
            
            callSids.push(retryCallControlId);
            results.successful++;

            await firebaseService.storeCallData(retryCallControlId, {
              callSid: retryCallControlId,
              callLegId: retryCall.call_leg_id,
              callSessionId: retryCall.call_session_id,
              broadcastId: broadcastId,
              contactId: contactId,
              contactName: contactName,
              phoneNumber: phone,
              script: script,
              status: 'pending'
            });

            console.log(`✅ Retry successful for ${phone}, call_control_id: ${retryCallControlId}`);
            
          } catch (retryError) {
            results.failed++;
            const retryErrorMsg = retryError.response?.data?.errors?.[0]?.detail || retryError.message;
            results.errors.push({ phone, error: `Retry failed: ${retryErrorMsg}` });
            
            console.error(`❌ Retry failed for ${phone}:`, retryErrorMsg);
            
            // If we're hitting too many consecutive channel limits, abort the batch
            if (results.channelLimitHits >= 3 && retryErrorMsg.includes('channel limit exceeded')) {
              console.warn(`🛑 Too many channel limit hits (${results.channelLimitHits}), aborting remaining calls in this batch to prevent account throttling`);
              
              // Mark remaining calls as failed to avoid infinite channel limit loops
              for (let j = i + 1; j < phoneNumbers.length; j++) {
                const remainingPhone = phoneNumbers[j]?.trim();
                if (remainingPhone) {
                  results.failed++;
                  results.errors.push({ phone: remainingPhone, error: 'Batch aborted due to excessive channel limits' });
                  
                  await firebaseService.storeCallData(`aborted_${Date.now()}_${j}`, {
                    broadcastId: broadcastId,
                    contactId: contactIds[j]?.trim() || `contact_${j}`,
                    contactName: contactNames[j]?.trim() || `Contact ${j + 1}`,
                    phoneNumber: remainingPhone,
                    script: contents[j] || contents[0],
                    status: 'failed',
                    error: 'Batch aborted due to excessive channel limits'
                  });
                }
              }
              break; // Exit the loop
            }
            
            // Store failed call attempt
            try {
              await firebaseService.storeCallData(`failed_${Date.now()}_${i}`, {
                broadcastId: broadcastId,
                contactId: contactId,
                contactName: contactName,
                phoneNumber: phone,
                script: script,
                status: 'failed',
                error: retryErrorMsg
              });
            } catch (storageError) {
              console.error('Error storing failed call data:', storageError);
            }
          }
        } else {
          // Non-channel-limit errors (invalid numbers, etc.)
          results.failed++;
          results.errors.push({ phone, error: errorMsg });
          
          console.error(`❌ Error creating call for ${phone}:`, errorMsg);
          
          // Store failed call attempt
          try {
            await firebaseService.storeCallData(`failed_${Date.now()}_${i}`, {
              broadcastId: broadcastId,
              contactId: contactId,
              contactName: contactName,
              phoneNumber: phone,
              script: script,
              status: 'failed',
              error: errorMsg
            });
          } catch (storageError) {
            console.error('Error storing failed call data:', storageError);
          }
        }
      }
    }

    console.log(`📊 Batch complete: ${results.successful} successful, ${results.failed} failed out of ${phoneNumbers.length} total`);
    console.log(`🔄 Channel limit hits: ${results.channelLimitHits}`);

    res.status(201).json({
      success: true,
      data: {
        broadcastId: broadcastId,
        callSids: callSids,
        totalCalls: phoneNumbers.length,
        successfulCalls: results.successful,
        failedCalls: results.failed,
        channelLimitHits: results.channelLimitHits,
        batchResults: results,
        errors: results.errors.length > 0 ? results.errors.slice(0, 5) : [], // Include first 5 errors for debugging
        recommendations: results.channelLimitHits >= 3 ? [
          "Consider upgrading your Telnyx account for higher channel limits",
          "Use smaller batch sizes for better success rates",
          "Consider spreading campaigns over longer time periods"
        ] : []
      }
    });

  } catch (error) {
    console.error('Error in /api/make-call:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error', 
      error: error.message 
    });
  }
});

// API endpoint to get call status
app.post('/api/call-status/:callSid', async (req, res) => {
  try {
    const { callSid } = req.params;
    
    const callData = await firebaseService.getCallData(callSid);
    
    if (!callData) {
      return res.status(404).json({
        success: false,
        message: 'Call not found'
      });
    }

    // Format response to match frontend expectations
    res.json({
      success: true,
      data: {
        ...callData,
        // Ensure status is available at the top level for frontend compatibility
        status: callData.status || 'pending'
      }
    });

  } catch (error) {
    console.error('Error getting call status:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving call status',
      error: error.message
    });
  }
});

// API endpoint to get call counts
app.get('/api/call-counts', async (req, res) => {
  try {
    const { broadcastId } = req.query;
    
    const counts = await firebaseService.getCallCounts(broadcastId);
    
    res.json({
      success: true,
      data: counts
    });

  } catch (error) {
    console.error('Error getting call counts:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving call counts',
      error: error.message
    });
  }
});

// API endpoint to cancel all calls
app.post('/api/cancel-all-calls', async (req, res) => {
  try {
    const { broadcastId } = req.body;
    
    let canceledCount = 0;
    
    if (broadcastId) {
      // Cancel specific broadcast
      canceledCount = await firebaseService.cancelBroadcastCalls(broadcastId);
    } else {
      // Get all active calls and cancel them
      const activeCalls = await firebaseService.getActiveCalls();
      
      for (const call of activeCalls) {
        try {
          // Try to hangup the call via Telnyx API
          await telnyx.calls.hangup(call.callControlId);
          
          // Update status in Firebase
          await firebaseService.updateCallStatus(call.callControlId, 'canceled');
          canceledCount++;
        } catch (error) {
          console.error(`Error canceling call ${call.callControlId}:`, error);
        }
      }
    }

    res.json({
      success: true,
      message: `Canceled ${canceledCount} calls`,
      canceledCount: canceledCount
    });

  } catch (error) {
    console.error('Error canceling calls:', error);
    res.status(500).json({
      success: false,
      message: 'Error canceling calls',
      error: error.message
    });
  }
});

app.post('/calls', async (req, res) => {
  const destinationNumber = '+15512773363';
  const telnyxPhoneNumber = '+18633049991';
  console.log(destinationNumber);
  console.log(telnyxPhoneNumber);
  const createCallRequest = {
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to: destinationNumber,
    from: telnyxPhoneNumber,
    answering_machine_detection: "detect_words",
    webhook_url: webhookUrl
  }
  try {
    const { data: call } = await telnyx.calls.create(createCallRequest);
    res.status(201).send({
          call_control_id: call.call_control_id,
          call_leg_id: call.call_leg_id,
          call_session_id: call.call_session_id
        });
    console.log(`Created outbound call_session_id: ${call.call_session_id}`);
  }
  catch (e) {
    console.log('Error creating call');
    console.log(e);
    res.status(400).send(e);
  }
});
app.post('/sms', async (req, res) => {
  const destinationNumber = '+15512773363';
  const telnyxPhoneNumber = '+18633049991';
  console.log(destinationNumber);
  console.log(telnyxPhoneNumber);
  const createCallRequest = {
    messaging_profile_id: process.env.TELNYX_MESSAGING_ID,
    to: destinationNumber,
    from: telnyxPhoneNumber,
    text: "Hello {firstName} {lastName}, this is a final procedural reminder regarding file number {fileNumber}. Action is required without delay. Contact 531-215-7299 immediately — that’s 531-215-7299. Reference file number {fileNumber}, again — file number {fileNumber}.",
    type: 'SMS',
    webhook_url: webhookUrl
  }
  try {
    const { data: message } = await telnyx.messages.create(createCallRequest);
    res.status(201).send({
          cost: message.cost.amount,
          id: message.id,
          type: message.type
        });
    // console.log(`Created outbound call_session_id: ${call.call_session_id}`);
  }
  catch (e) {
    console.log('Error creating call');
    console.log(e);
    res.status(400).send(e);
  }
});

app.listen(process.env.TELNYX_APP_PORT);
console.log(`Server listening on port ${process.env.TELNYX_APP_PORT}`);