const express  = require('express');
const router = module.exports = express.Router();
const axios = require('axios');

// Use Firebase for persistent storage
const firebaseService = require('./firebaseService');

// Minimum duration (in seconds) for answered calls before hangup
const MIN_ANSWERED_DURATION_SECS = parseInt(process.env.MIN_ANSWERED_DURATION_SECS || '6', 10);


const webhookController = async (req, res) => {
  try {
    const event = req.body;
    const type = event?.data?.event_type;
    const callControlId = event?.data?.payload?.call_control_id;

    console.log(`Webhook received: ${type} for call ${callControlId}`);

    if (!callControlId) {
      console.log('No call_control_id found in webhook');
      return res.sendStatus(200);
    }

    // Update call status in Firebase based on event type
    switch (type) {
      case 'call.initiated':
        await firebaseService.updateCallStatus(callControlId, 'initiated');
        break;

      case 'call.ringing':
        await firebaseService.updateCallStatus(callControlId, 'ringing');
        break;

      case 'call.answered':
        await firebaseService.updateCallStatus(callControlId, 'answered', {
          answeredAt: new Date()
        });
        
        // Get the call data to retrieve the script
        const callData = await firebaseService.getCallData(callControlId);
        
        if (callData && callData.script) {
          // Speak the personalized script
          try {
            await axios.post(
              `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`,
              {
                payload: callData.script,
                payload_type: 'text',
                service_level: 'basic',
                voice: 'AWS.Polly.Danielle-Neural',
                language: 'en-US'
              },
              { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
            );
            console.log(`Speaking script for call ${callControlId}`);
          } catch (speakError) {
            console.error('Error speaking script:', speakError);
          }
        }
        break;

      case 'call.hangup':
        // Determine if it was completed or failed based on hangup cause and duration
        const hangupCause = event?.data?.payload?.hangup_cause;
        const callDuration = event?.data?.payload?.call_duration_secs || 0;
        let status = 'completed';
        
        // Check for short duration calls that might trigger Telnyx warnings
        if (callDuration < MIN_ANSWERED_DURATION_SECS) {
          console.warn(`⚠️ Short duration call detected: ${callDuration}s for ${callControlId} (${hangupCause})`);
        }
        
        if (hangupCause === 'NO_ANSWER') {
          status = 'no-answer';
        } else if (hangupCause === 'BUSY') {
          status = 'busy';
        } else if (hangupCause === 'CANCEL') {
          status = 'canceled';
        } else if (hangupCause === 'REJECTED') {
          status = 'rejected';
        } else if (hangupCause === 'FAILED') {
          status = 'failed';
        } else if (callDuration < 2) {
          // Very short calls (< 2s) are likely invalid numbers or immediate failures
          status = 'failed';
          console.warn(`⚠️ Very short call (${callDuration}s) marked as failed: ${callControlId}`);
        }
        
        await firebaseService.updateCallStatus(callControlId, status, {
          hangupCause: hangupCause,
          duration: callDuration,
          endTime: new Date(),
          isShortDuration: callDuration < MIN_ANSWERED_DURATION_SECS
        });
        break;

      case 'call.machine.detection.ended':
        const machineDetection = event?.data?.payload?.machine_detection_result;
        if (machineDetection === 'human') {
          await firebaseService.updateCallStatus(callControlId, 'answered', {
            answeredAt: new Date()
          });
        } else if (machineDetection === 'machine') {
          await firebaseService.updateCallStatus(callControlId, 'voicemail');
          
          // Still speak the script for voicemail
          const vmCallData = await firebaseService.getCallData(callControlId);
          if (vmCallData && vmCallData.script) {
            try {
              await axios.post(
                `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`,
                {
                  payload: vmCallData.script,
                  payload_type: 'text',
                  service_level: 'basic',
                  voice: 'AWS.Polly.Danielle-Neural',
                  language: 'en-US'
                },
                { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
              );
              console.log(`Speaking script to voicemail for call ${callControlId}`);
            } catch (speakError) {
              console.error('Error speaking to voicemail:', speakError);
            }
          }
        }
        break;

      case 'call.speak.ended':
        // Mark as completed when speaking is done
        await firebaseService.updateCallStatus(callControlId, 'completed');

        // Fetch call to compute remaining time to meet minimum answered duration
        try {
          const callData = await firebaseService.getCallData(callControlId);
          const answeredAtRaw = callData?.answeredAt;
          let answeredAtMs = null;
          if (answeredAtRaw) {
            if (typeof answeredAtRaw === 'string' || answeredAtRaw instanceof Date) {
              answeredAtMs = new Date(answeredAtRaw).getTime();
            } else if (typeof answeredAtRaw === 'object' && typeof answeredAtRaw.toDate === 'function') {
              answeredAtMs = answeredAtRaw.toDate().getTime();
            }
          }
          const nowMs = Date.now();
          const minEndMs = (answeredAtMs || nowMs) + (MIN_ANSWERED_DURATION_SECS * 1000);
          const waitMs = Math.max(0, minEndMs - nowMs);

          setTimeout(async () => {
            try {
              await axios.post(
                `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
                {},
                { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
              );
              console.log(`Successfully hung up call ${callControlId} after speaking (waited ${waitMs}ms to satisfy min duration)`);
            } catch (hangupError) {
              if (hangupError.response?.status === 422) {
                console.log(`Call ${callControlId} already ended or cannot be hung up (422) - this is normal`);
              } else if (hangupError.response?.status === 404) {
                console.log(`Call ${callControlId} not found (404) - call may have already ended`);
              } else {
                console.error(`Error hanging up call ${callControlId}:`, {
                  status: hangupError.response?.status,
                  statusText: hangupError.response?.statusText,
                  data: hangupError.response?.data?.errors || hangupError.response?.data,
                  message: hangupError.message
                });
              }
            }
          }, waitMs);
        } catch (e) {
          console.error('Error computing minimum answered duration, proceeding with default 1s hangup:', e?.message || e);
          setTimeout(async () => {
            try {
              await axios.post(
                `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
                {},
                { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
              );
              console.log(`Successfully hung up call ${callControlId} after speaking (default wait)`);
            } catch (hangupError) {
              if (hangupError.response?.status === 422) {
                console.log(`Call ${callControlId} already ended or cannot be hung up (422) - this is normal`);
              } else if (hangupError.response?.status === 404) {
                console.log(`Call ${callControlId} not found (404) - call may have already ended`);
              } else {
                console.error(`Error hanging up call ${callControlId}:`, {
                  status: hangupError.response?.status,
                  statusText: hangupError.response?.statusText,
                  data: hangupError.response?.data?.errors || hangupError.response?.data,
                  message: hangupError.message
                });
              }
            }
          }, 1000);
        }
        break;

      case 'call.bridged':
        await firebaseService.updateCallStatus(callControlId, 'in-progress');
        break;

      default:
        console.log(`Unhandled webhook type: ${type}`);
        break;
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Error in webhook controller:', err?.response?.data || err.message);
    return res.status(200).send('ok'); // ack so Telnyx doesn't retry forever
  }
}


router.route('/webhook')
    .post(webhookController)