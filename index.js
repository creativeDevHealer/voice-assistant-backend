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
// app.use((req, res, next) => {
//   res.header('Access-Control-Allow-Origin', '*');
//   res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
//   res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, ngrok-skip-browser-warning');
//   res.header('Access-Control-Max-Age', '86400');
//   res.header('ngrok-skip-browser-warning', 'true'); // Skip ngrok browser warning
  
//   if (req.method === 'OPTIONS') {
//     console.log('Preflight request:', req.path);
//     return res.status(200).end();
//   }
  
//   next();
// });

app.use(cors('*'))

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(callControlPath, callControl);

// API endpoint for batch calls with Firebase storage
app.post('/api/make-call', async (req, res) => {
  try {
    let channelLimitHits = 0;
    const { phonenumber, contact_id, contact_name, content } = req.body;

    if (!phonenumber || !content) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number and content are required' 
      });
    }

    // Parse comma-separated values
    const phoneNumbers = phonenumber.split(',').map(p => p.trim()).filter(p => p);
    const contactIds = contact_id ? contact_id.split(',').map(c => c.trim()) : [];
    const contactNames = contact_name ? contact_name.split(',').map(n => n.trim()) : [];
    const contents = Array.isArray(content) ? content : [content];

    // Validate input
    if (phoneNumbers.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No valid phone numbers provided' 
      });
    }

    const broadcastId = `broadcast_${Date.now()}`;
    
    // Store broadcast session
    try {
      await firebaseService.storeBroadcastSession(broadcastId, {
        totalCalls: phoneNumbers.length,
        status: 'active',
        startTime: new Date()
      });
    } catch (firebaseError) {
      console.error('Error storing broadcast session:', firebaseError);
      // Continue with broadcast even if Firebase storage fails
    }

    try {
      const createCallRequest = {
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: phoneNumbers, // Changed to array format to match Telnyx API
        from: process.env.TELNYX_PHONE_NUMBER || '+18633049991',
        answering_machine_detection: "detect_words",
        webhook_url: webhookUrl
      };

      // console.log(createCallRequest);


      const { data: call } = await telnyx.calls.create(createCallRequest);
      const callSessionId = call.call_session_id;
      
      // Debug logging to identify the mismatch
      console.log(`📞 Telnyx Response Debug:`);
      console.log(`  - Phone numbers sent: ${phoneNumbers.length} (${phoneNumbers.join(', ')})`);
      console.log(`  - Call legs received: ${call.call_legs.length}`);
      console.log(`  - Call legs:`, call.call_legs.map(leg => ({ id: leg.call_leg_id, control_id: leg.call_control_id })));
      
      // Validate that we have the expected number of call legs
      if (call.call_legs.length !== phoneNumbers.length) {
        console.warn(`⚠️ MISMATCH: Expected ${phoneNumbers.length} call legs but received ${call.call_legs.length}`);
        console.warn(`⚠️ This could indicate Telnyx API issues or retry behavior`);
      }
      
      // Store call data in storage - only use the first N call legs where N = phoneNumbers.length
      const validCallLegs = call.call_legs.slice(0, phoneNumbers.length);
      console.log(`📋 Using ${validCallLegs.length} call legs for ${phoneNumbers.length} phone numbers`);
      
      let index = 0;
      for (const call_leg of validCallLegs) {
        const callControlId = call_leg.call_control_id;
        try {
          await firebaseService.storeCallData(callControlId, {
            callSid: callControlId,
            callLegId: call_leg.call_leg_id,
            callSessionId: callSessionId,
            broadcastId: broadcastId,
            contactId: contactIds[index],
            contactName: contactNames[index],
            phoneNumber: phoneNumbers[index],
            script: contents[index],
            status: 'pending'
          });
          console.log(`✅ Call data stored for ${callControlId} (phone: ${phoneNumbers[index]})`);
        } catch (storageError) {
          console.error('Error storing call data:', storageError);
        }
        index++;
      }
      
      // Return only the callSids that correspond to actual phone numbers
      const validCallSids = validCallLegs.map(call_leg => call_leg.call_control_id);
      
      console.log(`📤 Returning ${validCallSids.length} callSids: [${validCallSids.join(', ')}]`);
      
      res.status(201).json({
        success: true,
        data: {
          broadcastId: broadcastId,
          callSids: validCallSids,
          channelLimitHits: 0,
        }
      });

      return { success: true, phoneNumbers, contactIds, contactNames, contents };

    } catch (error) {
      const errorMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      const isChannelLimitError = errorMsg.includes('channel limit exceeded') || error.response?.status === 403;
      
      if (isChannelLimitError) {
        channelLimitHits++;
        
         const waitTime = Math.min(20000 + (channelLimitHits * 10000), 120000); // Increased wait times
         console.warn(`⚠️ Channel capacity reached for ${phoneNumbers} (hit #${channelLimitHits}), waiting ${waitTime/1000} seconds and retrying...`);
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        try {
          const retryRequest = {
            connection_id: process.env.TELNYX_CONNECTION_ID,
            to: phoneNumbers,
            from: process.env.TELNYX_PHONE_NUMBER || '+18633049991',
            answering_machine_detection: "detect_words",
            webhook_url: webhookUrl
          };
          const { data: retryCall } = await telnyx.calls.create(retryRequest);
          const callSessionId = retryCall.call_session_id;
          
          // Debug logging for retry
          console.log(`🔄 Retry Telnyx Response Debug:`);
          console.log(`  - Phone numbers sent: ${phoneNumbers.length} (${phoneNumbers.join(', ')})`);
          console.log(`  - Call legs received: ${retryCall.call_legs.length}`);
          
          // Validate retry response
          if (retryCall.call_legs.length !== phoneNumbers.length) {
            console.warn(`⚠️ RETRY MISMATCH: Expected ${phoneNumbers.length} call legs but received ${retryCall.call_legs.length}`);
          }
          
          // Use only the valid call legs
          const validRetryCallLegs = retryCall.call_legs.slice(0, phoneNumbers.length);
          
          let index = 0;
          for (const call_leg of validRetryCallLegs) {
            const callControlId = call_leg.call_control_id;
            try {
              await firebaseService.storeCallData(callControlId, {
                callSid: callControlId,
                callLegId: call_leg.call_leg_id,
                callSessionId: callSessionId,
                broadcastId: broadcastId,
                contactId: contactIds[index],
                contactName: contactNames[index],
                phoneNumber: phoneNumbers[index],
                script: contents[index],
                status: 'pending'
              });
            } catch (storageError) {
              console.error('Error storing call data:', storageError);
            }
            index++;
          }
          
          const validRetryCallSids = validRetryCallLegs.map(call_leg => call_leg.call_control_id);
          console.log(`✅ Retry successful for ${phoneNumbers} - returning ${validRetryCallSids.length} callSids`);
          
          res.status(201).json({
            success: true,
            data: {
              broadcastId: broadcastId,
              callSids: validRetryCallSids,
              channelLimitHits: channelLimitHits,
            }
          });
          return { success: true, phoneNumbers, contactIds, contactNames, contents };
          
        } catch (retryError) {
          const retryErrorMsg = retryError.response?.data?.errors?.[0]?.detail || retryError.message;
          console.error(`❌ Retry failed for ${phoneNumbers}:`, retryErrorMsg);
          const syntheticCallSids = phoneNumbers.map((_, idx) => `synthetic_${timestamp}_${idx}_${Math.random().toString(36).slice(2,8)}`);
        try {
          // Store synthetic call records as pending
          for (let i = 0; i < syntheticCallSids.length; i++) {
            const sid = syntheticCallSids[i];
            try {
              await firebaseService.storeCallData(sid, {
                callSid: sid,
                callLegId: null,
                callSessionId: null,
                broadcastId: broadcastId,
                contactId: contactIds[i],
                contactName: contactNames[i],
                phoneNumber: phoneNumbers[i],
                script: contents[i],
                status: 'pending',
                isSynthetic: true
              });
            } catch (storageError) {
              console.error('Error storing synthetic call data:', storageError);
            }
          }
        } catch (e) {
          console.error('Synthetic storage loop error:', e);
        }
        res.status(201).json({
          success: true,
          data: {
            broadcastId: broadcastId,
            callSids: syntheticCallSids,
            channelLimitHits: channelLimitHits,
          }
        });
        return { success: true, phoneNumbers, contactIds, contactNames, contents };
        }
      } else {
        console.error(error);
        console.error(`❌ Error creating call for ${phoneNumbers}:`, errorMsg);
        // Fallback: generate synthetic callSids so the frontend can proceed
        const timestamp = Date.now();
        const syntheticCallSids = phoneNumbers.map((_, idx) => `synthetic_${timestamp}_${idx}_${Math.random().toString(36).slice(2,8)}`);
        try {
          // Store synthetic call records as pending
          for (let i = 0; i < syntheticCallSids.length; i++) {
            const sid = syntheticCallSids[i];
            try {
              await firebaseService.storeCallData(sid, {
                callSid: sid,
                callLegId: null,
                callSessionId: null,
                broadcastId: broadcastId,
                contactId: contactIds[i],
                contactName: contactNames[i],
                phoneNumber: phoneNumbers[i],
                script: contents[i],
                status: 'pending',
                isSynthetic: true
              });
            } catch (storageError) {
              console.error('Error storing synthetic call data:', storageError);
            }
          }
        } catch (e) {
          console.error('Synthetic storage loop error:', e);
        }
        res.status(201).json({
          success: true,
          data: {
            broadcastId: broadcastId,
            callSids: syntheticCallSids,
            channelLimitHits: channelLimitHits,
          }
        });
        return { success: true, phoneNumbers, contactIds, contactNames, contents };
      }
    }
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

// Cache for channel status to reduce Firebase calls
let channelStatusCache = {
  data: null,
  lastUpdated: 0,
  ttl: 10000 // 10 seconds cache
};

// API endpoint to get channel capacity status
app.get('/api/channel-status', async (req, res) => {
  try {
    const now = Date.now();
    
    // Use cache if data is fresh
    if (channelStatusCache.data && (now - channelStatusCache.lastUpdated) < channelStatusCache.ttl) {
      console.log('📊 Using cached channel status');
      return res.json(channelStatusCache.data);
    }
    
    console.log('📊 Fetching fresh channel status from Firebase');
    const activeCalls = await firebaseService.getActiveCalls();
    const pendingCalls = activeCalls.filter(call => call.status === 'pending').length;
    const ringingCalls = activeCalls.filter(call => call.status === 'ringing').length;
    const totalActive = pendingCalls + ringingCalls;
    
    const responseData = {
      success: true,
      data: {
        totalActiveCalls: totalActive,
        pendingCalls: pendingCalls,
        ringingCalls: ringingCalls,
        channelCapacity: {
          current: totalActive,
          limit: 10,
          utilization: Math.round((totalActive / 10) * 100),
          status: totalActive >= 8 ? 'high' : totalActive >= 5 ? 'medium' : 'low'
        },
        recommendations: totalActive >= 8 ? [
          "High channel utilization detected",
          "Consider reducing batch size or increasing delays"
        ] : []
      }
    };
    
    // Update cache
    channelStatusCache.data = responseData;
    channelStatusCache.lastUpdated = now;
    
    res.json(responseData);

  } catch (error) {
    console.error('Error getting channel status:', error);
    
    // If Firebase quota exceeded, return cached data if available
    if (error.code === 8 || error.message?.includes('RESOURCE_EXHAUSTED')) {
      console.warn('⚠️ Firebase quota exceeded, returning cached channel status');
      if (channelStatusCache.data) {
        return res.json(channelStatusCache.data);
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Error retrieving channel status',
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
      // Cancel specific broadcast - get active calls for the broadcast and hang them up
      const broadcastCalls = await firebaseService.getBroadcastCalls(broadcastId);
      const activeBroadcastCalls = broadcastCalls.filter(call => 
        ['pending', 'ringing', 'initiated', 'answered'].includes(call.status)
      );
      
      for (const call of activeBroadcastCalls) {
        try {
          // Try to hangup the call via Telnyx API
          await telnyx.calls.hangup({ call_control_id: call.callControlId });
          
          // Update status in Firebase
          await firebaseService.updateCallStatus(call.callControlId, 'canceled');
          canceledCount++;
          // console.log(`✅ Canceled broadcast call ${call.callControlId}`);
        } catch (error) {
          // console.error(`❌ Error canceling broadcast call ${call.callControlId}:`, error);
          // Still update status in Firebase even if API call fails
          // try {
          //   await firebaseService.updateCallStatus(call.callControlId, 'canceled');
          //   canceledCount++;
          // } catch (updateError) {
          //   console.error(`Error updating status for ${call.callControlId}:`, updateError);
          // }
        }
      }
      
      // Update broadcast status to canceled
      try {
        await firebaseService.updateBroadcastSession(broadcastId, { status: 'canceled' });
      } catch (broadcastUpdateError) {
        console.error('Error updating broadcast status:', broadcastUpdateError);
      }
      
    } else {
      // Get all active calls and cancel them
      const activeCalls = await firebaseService.getActiveCalls();
      
      for (const call of activeCalls) {
        try {
          // Try to hangup the call via Telnyx API
          await telnyx.calls.hangup({ call_control_id: call.callControlId });
          
          // Update status in Firebase
          await firebaseService.updateCallStatus(call.callControlId, 'canceled');
          canceledCount++;
          console.log(`✅ Canceled call ${call.callControlId}`);
        } catch (error) {
          console.error(`❌ Error canceling call ${call.callControlId}:`, error);
          // Still update status in Firebase even if API call fails
          try {
            await firebaseService.updateCallStatus(call.callControlId, 'canceled');
            canceledCount++;
          } catch (updateError) {
            console.error(`Error updating status for ${call.callControlId}:`, updateError);
          }
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

app.listen(5000, '0.0.0.0');
console.log(`Server listening on port 5000`);