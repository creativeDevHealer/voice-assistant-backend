const express  = require('express');
const router = module.exports = express.Router();
const axios = require('axios');

const mongodbService = require('./mongodbService');

const callStates = new Map();


const webhookController = async (req, res) => {
  try {
    const event = req.body;
    const type = event?.data?.event_type;
    const callControlId = event?.data?.payload?.call_control_id;
    const payload = event?.data?.payload || {};
    if (!callControlId) {
      console.log('No call_control_id found in webhook');
      return res.sendStatus(200);
    }
    // Initialize call state if not exists
    if (!callStates.has(callControlId)) {
      callStates.set(callControlId, { scriptPlayed: false, amdResult: null });
    }
    const callState = callStates.get(callControlId);
    switch (type) {
      case 'call.initiated':
        const direction = event?.data?.payload?.direction;
        const fromNumber = event?.data?.payload?.from;
        const toNumber = event?.data?.payload?.to;
        if (direction === 'incoming') {
          try {
            await axios.post(
              `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
              {
                to: '+14633631323',
                from: fromNumber
              },
              { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
            );
            console.log('Redirected inbound call from ${fromNumber} to your real phone');
          } catch (error) {
            console.error('Error redirecting inbound call');
          }
        }
        break;
      case 'call.answered':
        console.log('Call answered');
        break;
      case 'call.hangup':
        // Clean up call state when call ends
        callStates.delete(callControlId);
        console.log('Call ended, cleaned up state');
        break;
      case 'call.speak.ended':
        const hangupUrl = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`;
        await axios.post(hangupUrl, {}, {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });
        console.log('Call hung up after message completed');
        break;
      case 'call.machine.premium.detection.ended':
        const result = payload.result;
        callState.amdResult = result;
        console.log(`AMD Result: ${result}`);
        if (result === 'machine') {
          console.log('Machine detected - waiting for greeting to end');
          // DON'T play script here - wait for greeting to end
        } else {
          console.log('Human answered the call');
          // Only play if script hasn't been played yet
          if (!callState.scriptPlayed) {
            try {
              const callData = await mongodbService.getCallData(callControlId);
              if (callData && callData.script) {
                await speakScript(callControlId, callData.script);
                callState.scriptPlayed = true;
              } else {
                console.error('No script found for call:', callControlId);
              }
            } catch (error) {
              console.error('Error speaking script:', error);
            }
          }
        }
        break;
      case 'call.machine.premium.greeting.ended':
        console.log('Voicemail greeting ended');
        // Only play if script hasn't been played yet
        if (!callState.scriptPlayed) {
          try {
            const callData = await mongodbService.getCallData(callControlId);
            if (callData && callData.script) {
              await new Promise(resolve => setTimeout(resolve, 4000));
              await speakScript(callControlId, callData.script);
              callState.scriptPlayed = true;
            } else {
              console.error('No script found for call:', callControlId);
            }
          } catch (error) {
            console.error('Error speaking script:', error);
          }
        } else {
          console.log('Script already played, skipping');
        }
        break;
      default:
        break;
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error in webhook controller:', err?.response?.data || err.message);
    return res.status(200).send('ok');
  }
}
async function speakScript(callControlId, script) {
  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`,
      {
        payload: script,
        payload_type: 'text',
        service_level: 'premium',
        voice: 'AWS.Polly.Danielle-Neural',
        language: 'en-US'
      },
      { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
    );
    console.log('Script played successfully');
  } catch (speakError) {
    console.error('Error speaking script:', speakError?.response?.data || speakError.message);
  }
}

router.route('/webhook')
    .post(webhookController)