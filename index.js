require('dotenv').config()

const express = require('express');
const cors = require('cors');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);
const firebaseService = require('./firebaseService');

const callControlPath = '/call-control';
const callControlOutboundPath = `${callControlPath}/webhook`;
const webhookUrl = (new URL(callControlOutboundPath, process.env.BASE_URL)).href;

const callControl = require('./callControl');
const app = express();

app.use(cors());
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

    for (let i = 0; i < phoneNumbers.length; i++) {
      const phone = phoneNumbers[i]?.trim();
      const contactId = contactIds[i]?.trim() || `contact_${i}`;
      const contactName = contactNames[i]?.trim() || `Contact ${i + 1}`;
      const script = contents[i] || contents[0]; // Use individual content or first one

      if (!phone) continue;

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

        // Store call data in Firebase
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

        console.log(`Created call for ${phone}, call_control_id: ${callControlId}`);
        
        // Small delay between calls to avoid rate limiting
        if (i < phoneNumbers.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

      } catch (error) {
        console.error(`Error creating call for ${phone}:`, error);
        // Store failed call attempt
        await firebaseService.storeCallData(`failed_${Date.now()}_${i}`, {
          broadcastId: broadcastId,
          contactId: contactId,
          contactName: contactName,
          phoneNumber: phone,
          script: script,
          status: 'failed',
          error: error.message
        });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        broadcastId: broadcastId,
        callSids: callSids,
        totalCalls: phoneNumbers.length,
        successfulCalls: callSids.length
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