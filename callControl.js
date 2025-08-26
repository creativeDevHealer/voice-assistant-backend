const express  = require('express');
const router = module.exports = express.Router();
const axios = require('axios');

// Use Firebase for persistent storage
const firebaseService = require('./firebaseService');


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
        await firebaseService.updateCallStatus(callControlId, 'initiated', {
          startTime: new Date().toISOString()
        });
        break;

      case 'call.answered':
        await firebaseService.updateCallStatus(callControlId, 'answered');
        
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
            
            // If speaking fails, still set a fallback timeout to hang up
            setTimeout(async () => {
              try {
                await axios.post(
                  `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
                  {},
                  { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
                );
                console.log(`Hung up call ${callControlId} after speak error`);
              } catch (hangupError) {
                console.error(`Error hanging up call ${callControlId} after speak error:`, hangupError);
              }
            }, 10000); // 10 second fallback timeout
          }
        }
        
        // Set maximum call duration timeout (60 seconds) as a safety net
        setTimeout(async () => {
          try {
            await axios.post(
              `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
              {},
              { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
            );
            console.log(`Hung up call ${callControlId} due to maximum duration timeout`);
            await firebaseService.updateCallStatus(callControlId, 'timeout');
          } catch (hangupError) {
            if (hangupError.response?.status === 422 || hangupError.response?.status === 404) {
              console.log(`Call ${callControlId} already ended when trying timeout hangup - this is normal`);
            } else {
              console.error(`Error hanging up call ${callControlId} on timeout:`, hangupError);
            }
          }
        }, 60000); // 60 second maximum call duration
        break;

      case 'call.hangup':
        // Determine if it was completed or failed based on hangup cause
        const hangupCause = event?.data?.payload?.hangup_cause;
        let status = 'completed';
        
        if (hangupCause === 'NO_ANSWER') {
          status = 'no-answer';
        } else if (hangupCause === 'BUSY') {
          status = 'busy';
        } else if (hangupCause === 'CANCEL') {
          status = 'canceled';
        } else if (hangupCause === 'timeout') {
          status = 'timeout';
        } else if (hangupCause === 'normal_clearing') {
          status = 'normal_clearing';
        }
        await firebaseService.updateCallStatus(callControlId, status, {
          hangupCause: hangupCause,
          duration: event?.data?.payload?.call_duration_secs
        });
        break;

      case 'call.machine.detection.ended':
        const machineDetection = event?.data?.payload?.machine_detection_result;
        if (machineDetection === 'machine') {
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
        } else {
          console.log(`Machine detection result for ${callControlId}: ${machineDetection} (human detected)`);
        }
        break;

      case 'call.speak.ended':
        // Mark as completed when speaking is done
        await firebaseService.updateCallStatus(callControlId, 'completed');
        
        // Get call data to check when call started for minimum duration enforcement
        const callDataForDuration = await firebaseService.getCallData(callControlId);
        
        // Calculate minimum hangup delay to ensure calls are at least 7 seconds long
        const calculateHangupDelay = () => {
          // Default 2 second delay to let the spoken message settle
          let delay = 2000;
          
          // If we have call start time, ensure minimum 7 seconds total duration
          if (callDataForDuration?.startTime) {
            const callStartTime = new Date(callDataForDuration.startTime);
            const currentTime = new Date();
            const currentDuration = (currentTime.getTime() - callStartTime.getTime()) / 1000;
            
            if (currentDuration < 7) {
              // Add extra delay to reach 7 seconds minimum
              delay = Math.max(delay, (7 - currentDuration) * 1000);
              console.log(`Call ${callControlId} duration ${currentDuration}s, adding ${delay/1000}s delay for minimum duration`);
            }
          }
          
          return delay;
        };
        
        // Wait for calculated delay then try to hang up the call
        setTimeout(async () => {
          try {
            await axios.post(
              `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
              {},
              { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
            );
            console.log(`Successfully hung up call ${callControlId} after speaking`);
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
        }, calculateHangupDelay());
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