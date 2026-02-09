require('dotenv').config()

const express = require('express');
const cors = require('cors');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

// Use MongoDB for persistent storage
const mongodbService = require('./mongodbService');

const callControlPath = '/call-control';
const callControlOutboundPath = `${callControlPath}/webhook`;
const webhookUrl = (new URL(callControlOutboundPath, process.env.BASE_URL)).href;

const callControl = require('./callControl');
const app = express();

const fromPhoneNumbers = 
['+18632228419', '+16416660012', '+18633049991',
  '+14646660141', '+16452305182', '+14645298077',
  '+18632228638', '+14644001131', '+13187825613',
  '+14642402651', '+15053988427', '+15054941679',
  '+17287771009', '+15057336762', '+15059430490',
  '+16452305186', '+16452305189', '+17287771010',
  '+17287771040', '+17282140046', '+16452305184',
  '+16452199148', '+14646660162', '+15053548299',
  '+15053548736', '+15054941445', '+17287771178',
  '+16452305176', '+16452305171', '+14645298168',
  '+17287771072', '+17287771015', '+13188584130',
  '+12105100544', '+12107618374',
];
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

// API endpoint for batch calls with MongoDB storage
app.post('/api/make-call', async (req, res) => {
  try {
    const { phonenumber, contact_id, contact_name, content, batchIndex } = req.body;

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
    const contents = Array.isArray(content) ? content : 
                     phoneNumbers.length > 1 ? phoneNumbers.map(() => content) : [content];

    if (phoneNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid phone numbers provided'
      });
    }

    const broadcastId = `broadcast_${Date.now()}`;
    const callSids = [];
    let channelLimitHits = 0;

    // Store broadcast session
    try {
      await mongodbService.storeBroadcastSession(broadcastId, {
        totalCalls: phoneNumbers.length,
        status: 'active',
        startTime: new Date()
      });
    } catch (mongodbError) {
      console.error('Error storing broadcast session:', mongodbError);
    }

    // Process each phone number INDIVIDUALLY
    for (let i = 0; i < phoneNumbers.length; i++) {
      const phoneNumber = phoneNumbers[i];
      const fromNumber = fromPhoneNumbers[(batchIndex + i) % fromPhoneNumbers.length];

      try {
        const createCallRequest = {
          connection_id: process.env.TELNYX_CONNECTION_ID,
          to: phoneNumber, //  Single phone number string, NOT an array
          from: fromNumber,
          answering_machine_detection: "premium",
          answering_machine_detection_config: {
            total_analysis_time_millis: 7000,
            greeting_total_analysis_time_millis: 7000,
            after_greeting_silence_millis: 2000,
            between_words_silence_millis: 100,
            maximum_number_of_words: 8,
            maximum_word_length_millis: 4000,
            silence_threshold: 256
          },
          webhook_url: "http://188.227.196.46:5000/call-control/webhook"  //  Plain URL
        };

        const { data: call } = await telnyx.calls.create(createCallRequest);
        const callControlId = call.call_control_id;

        await mongodbService.storeCallData(callControlId, {
          callSid: callControlId,
          callLegId: call.call_leg_id,
          callSessionId: call.call_session_id,
          broadcastId: broadcastId,
          contactId: contactIds[i] || null,
          contactName: contactNames[i] || null,
          phoneNumber: phoneNumber,
          script: contents[i] || contents[0],
          status: 'pending'
        });

        callSids.push(callControlId);
        console.log(`Call initiated to ${phoneNumber}: ${callControlId}`);

        //  Add delay between calls to avoid rate limiting
        if (i < phoneNumbers.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }

      } catch (error) {
        const errorMsg = error.response?.data?.errors?.[0]?.detail || error.message;
        const isChannelLimitError = errorMsg.includes('channel limit exceeded') || error.response?.status === 403;

        if (isChannelLimitError) {
          channelLimitHits++;
          const waitTime = Math.min(20000 + (channelLimitHits * 10000), 120000);
          console.warn(`Channel limit hit for ${phoneNumber}, waiting ${waitTime/1000}s...`);

          await new Promise(resolve => setTimeout(resolve, waitTime));
          i--; // Retry this phone number
          continue;
        } else {
          console.error(`Error calling ${phoneNumber}: ${errorMsg}`);
          const syntheticSid = `synthetic_${Date.now()}_${i}`;
          await mongodbService.storeCallData(syntheticSid, {
            callSid: syntheticSid,
            broadcastId: broadcastId,
            phoneNumber: phoneNumber,
            script: contents[i] || contents[0],
            status: 'failed',
            isSynthetic: true,
            error: errorMsg
          });
          callSids.push(syntheticSid);
        }
      }
    }

    return res.status(201).json({
      success: true,
      data: {
        broadcastId: broadcastId,
        callSids: callSids,
        channelLimitHits: channelLimitHits,
        totalCalls: phoneNumbers.length
      }
    });

  } catch (error) {
    console.error('Error in /api/make-call:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// API endpoint to get call status
app.post('/api/call-status/:callSid', async (req, res) => {
  try {
    const { callSid } = req.params;
    
    const callData = await mongodbService.getCallData(callSid);
    
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
    
    const counts = await mongodbService.getCallCounts(broadcastId);
    
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

// API endpoint to get Telnyx balance (proxy to avoid CORS)
app.post('/api/telnyx-balance', async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        message: 'API key is required'
      });
    }

    // console.log('🔍 Fetching Telnyx balance with provided API key');
    
    // Create a new Telnyx instance with the provided API key
    
    // Fetch balance from Telnyx API
    const balance = await telnyx.balance.retrieve();
    
    // console.log('✅ Successfully fetched Telnyx balance:', balance);
    
    res.json({
      success: true,
      data: {
        balance: balance.data.balance,
        currency: balance.data.currency
      }
    });

  } catch (error) {
    // console.error('❌ Error fetching Telnyx balance:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving balance from Telnyx',
      error: error.message
    });
  }
});

// Cache for channel status to reduce MongoDB calls
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
    
    console.log('📊 Fetching fresh channel status from MongoDB');
    const activeCalls = await mongodbService.getActiveCalls();
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
    
    // If MongoDB connection error, return cached data if available
    if (error.message?.includes('connection') || error.message?.includes('timeout')) {
      console.warn('⚠️ MongoDB connection error, returning cached channel status');
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
      const broadcastCalls = await mongodbService.getBroadcastCalls(broadcastId);
      const activeBroadcastCalls = broadcastCalls.filter(call => 
        ['pending', 'ringing', 'initiated', 'answered'].includes(call.status)
      );
      
      for (const call of activeBroadcastCalls) {
        try {
          // Try to hangup the call via Telnyx API
          await telnyx.calls.hangup({ call_control_id: call.callControlId });
          
          // Update status in MongoDB
          await mongodbService.updateCallStatus(call.callControlId, 'canceled');
          canceledCount++;
          // console.log(`✅ Canceled broadcast call ${call.callControlId}`);
        } catch (error) {
          // console.error(`❌ Error canceling broadcast call ${call.callControlId}:`, error);
          // Still update status in MongoDB even if API call fails
          // try {
          //   await mongodbService.updateCallStatus(call.callControlId, 'canceled');
          //   canceledCount++;
          // } catch (updateError) {
          //   console.error(`Error updating status for ${call.callControlId}:`, updateError);
          // }
        }
      }
      
      // Update broadcast status to canceled
      try {
        await mongodbService.updateBroadcastSession(broadcastId, { status: 'canceled' });
      } catch (broadcastUpdateError) {
        console.error('Error updating broadcast status:', broadcastUpdateError);
      }
      
    } else {
      // Get all active calls and cancel them
      const activeCalls = await mongodbService.getActiveCalls();
      
      for (const call of activeCalls) {
        try {
          // Try to hangup the call via Telnyx API
          await telnyx.calls.hangup({ call_control_id: call.callControlId });
          
          // Update status in MongoDB
          await mongodbService.updateCallStatus(call.callControlId, 'canceled');
          canceledCount++;
          console.log(`✅ Canceled call ${call.callControlId}`);
        } catch (error) {
          console.error(`❌ Error canceling call ${call.callControlId}:`, error);
          // Still update status in MongoDB even if API call fails
          try {
            await mongodbService.updateCallStatus(call.callControlId, 'canceled');
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