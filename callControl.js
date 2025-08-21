const express  = require('express');
const router = module.exports = express.Router();
const axios = require('axios');

// Use shared in-memory storage for testing (temporary replacement for Firebase)
const firebaseService = require('./memoryStorage');


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
          }
        }
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
        }
        
        await firebaseService.updateCallStatus(callControlId, status, {
          hangupCause: hangupCause,
          duration: event?.data?.payload?.call_duration_secs
        });
        break;

      case 'call.machine.detection.ended':
        const machineDetection = event?.data?.payload?.machine_detection_result;
        if (machineDetection === 'human') {
          await firebaseService.updateCallStatus(callControlId, 'answered');
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
        
        // Wait a moment then try to hang up the call after speaking
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
        }, 1000); // Wait 1 second before hanging up
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