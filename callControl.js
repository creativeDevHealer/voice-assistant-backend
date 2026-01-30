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
      callStates.set(callControlId, { scriptPlayed: false, amdResult: null, gatherAttempts:0, consentGiven:false });
    }
    const callState = callStates.get(callControlId);
    switch (type) {
      case 'call.initiated':
        const direction = event?.data?.payload?.direction;
        const fromNumber = event?.data?.payload?.from;
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
        if(callState.amdResult === 'machine' && callState.scriptPlayed){
          await hangupCall(callControlId);
          console.log('Call hung up after voicemail message');
        }
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
          await playConsentMessageAndGather(callControlId);
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
      case 'call.gather.ended':
        const digits = payload.digits;
        const status = payload.status;
        console.log(`DTMF input: ${digits}, status: ${status}`);
        if (status === 'valid') {
          if (digits === '1') {
            callState.consentGiven = true;
            await logConsent(callControlId, payload);
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
          } else if (digits === '2') {
            console.log('Thank you. Goodbye.');
            await speakScript(callControlId, 'Thank you. Goodbye.');
            setTimeout(() => hangupCall(callControlId), 2000);
          } else {
            callState.gatherAttempts++;
            if (callState.gatherAttempts < 3) {
              await speakScript(callControlId, 'Invalid input. Please press 1 to consent or 2 to decline.');
              await gatherInput(callControlId);
            } else {
              await speakScript(callControlId, 'Too many invalid attempts. Goodbye.');
              setTimeout(() => hangupCall(callControlId), 2000);
            }
          }
        } else {
          callState.gatherAttempts++;
          if (callState.gatherAttempts < 3) {
            await speakScript(callControlId, 'We did not receive your input. Please press 1 to consent or 2 to decline.');
            await gatherInput(callControlId);
          } else {
            await hangupCall(callControlId);
          }
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

async function logConsent(callControlId, payload) {
  try {
    // await mongodbService.saveConsent({
    //   callControlId: callControlId,
    //   callSessionId: payload.call_session_id,
    //   from: payload.from,
    //   to: payload.to,
    //   consentGiven: true,
    //   timestamp: new Date()
    // });
    console.log('Consent logged successfully');
  } catch (error) {
    console.error('Error logging consent:', error);
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

async function playConsentMessageAndGather(callControlId) {
  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/gather_using_speak`,
      {
        payload: "Hello, this is PPG. You've been named a reference for someone. To consent to hear important information regarding his case, please press 1 to consent or press 2 to decline.",
        payload_type: "text",
        voice: "female",
        language: "en-US",
        minimum_digits: 1,
        maximum_digits: 1,
        timeout_millis: 10000,
        valid_digits: "12"
      },
      { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
    );
  } catch (error) {
    console.error('Error:', error?.response?.data || error.message);
  }
}

async function gatherInput(callControlId) {
  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/gather`,
      {
        minimum_digits: 1,
        maximum_digits: 1,
        timeout_millis: 10000,
        valid_digits: "12"
      },
      { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
    );
    console.log('Gathering DTMF input');
  } catch (error) {
    console.error('Error gathering input:', error?.response?.data || error.message);
  }
}

async function hangupCall(callControlId) {
  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
      {},
      { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
    );
    console.log('Call hung up successfully');
  } catch (error) {
    console.error('Error hanging up call:', error?.response?.data || error.message);
  }
}

router.route('/webhook')
    .post(webhookController)