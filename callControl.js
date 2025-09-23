const express  = require('express');
const router = module.exports = express.Router();
const axios = require('axios');

// Use Firebase for persistent storage
const firebaseService = require('./firebaseService');

// Telnyx SMS configuration
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

// Minimum duration (in seconds) for answered calls before hangup
const MIN_ANSWERED_DURATION_SECS = parseInt(process.env.MIN_ANSWERED_DURATION_SECS || '6', 10);

// SMS sending function
const sendSMS = async (destinationNumber, message) => {
  try {
    const smsRequest = {
      messaging_profile_id: process.env.TELNYX_MESSAGING_ID,
      to: destinationNumber,
      from: process.env.TELNYX_PHONE_NUMBER || '+18633049991',
      text: message,
      type: 'SMS'
    };

    const { data: smsResponse } = await telnyx.messages.create(smsRequest);
    // console.log(`SMS sent successfully to ${destinationNumber}:`, {
    //   id: smsResponse.id,
    //   cost: smsResponse.cost?.amount
    // });
    return { success: true, messageId: smsResponse.id };
  } catch (error) {
    console.error(`Error sending SMS to ${destinationNumber}:`, error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
};


const webhookController = async (req, res) => {
  try {
    const event = req.body;
    const type = event?.data?.event_type;
    const callControlId = event?.data?.payload?.call_control_id;

    if(event.data.event_type.includes('call')){
      console.log(event.data.payload.call_control_id);
    }

    if (!callControlId) {
      // console.log('No call_control_id found in webhook');
      return res.sendStatus(200);
    }

    // Update call status in Firebase based on event type
    switch (type) {
      case 'call.initiated':
        const direction = event?.data?.payload?.direction;
        const fromNumber = event?.data?.payload?.from;
        const toNumber = event?.data?.payload?.to; // Your Telnyx number
        // console.log(direction, fromNumber, toNumber);
        if (direction === 'incoming') {
          // console.log(`Inbound call from ${fromNumber} to ${toNumber}`);
          
          // Redirect to your real phone number
          try {
            await axios.post(
              `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
              {
                to: '+15015855834', // Replace with your real phone number
                from: fromNumber
              },
              { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
            );
            console.log(`✅ Redirected inbound call from ${fromNumber} to your real phone`);
          } catch (error) {
            console.error('❌ Error redirecting inbound call:', error);
          }
        } else {
          // Handle outbound calls normally
          await firebaseService.updateCallStatus(callControlId, 'initiated');
        }
        break;

      case 'call.answered':
        await firebaseService.updateCallStatus(callControlId, 'completed', {
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
            // console.log(`Speaking script for call ${callControlId}`);
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
          // console.warn(`⚠️ Short duration call detected: ${callDuration}s for ${callControlId} (${hangupCause})`);
        }
        
        // Define hangup causes that should trigger SMS
        const smsTriggerCauses = ['not_found', 'user_busy', 'canceled', 'normal_clearing', 'timeout'];
        
        
        // Send SMS for specific hangup causes
        if (smsTriggerCauses.includes(hangupCause)) {
          try {
            const callData = await firebaseService.getCallData(callControlId);
            if (callData && callData.phoneNumber) {
              const vmCallData = await firebaseService.getCallData(callControlId);
              const smsResult = await sendSMS(callData.phoneNumber, vmCallData.script);
              // console.log(vmCallData.script);
              
              if (smsResult.success) {
                // console.log(`📱 SMS sent to ${callData.phoneNumber} for hangup cause: ${hangupCause}`);
                // SMS success -> update status to "completed"
                await firebaseService.updateCallStatus(callControlId, 'completed', {
                  hangupCause: hangupCause,
                  duration: callDuration,
                  endTime: new Date(),
                  isShortDuration: callDuration < MIN_ANSWERED_DURATION_SECS,
                  smsSent: true,
                  smsMessageId: smsResult.messageId
                });
              } else {
                console.error(`❌ Failed to send SMS to ${callData.phoneNumber}:`, smsResult.error);
                // SMS failed -> update status to "failed"
                await firebaseService.updateCallStatus(callControlId, 'completed', {
                  hangupCause: hangupCause,
                  duration: callDuration,
                  endTime: new Date(),
                  isShortDuration: callDuration < MIN_ANSWERED_DURATION_SECS,
                  smsSent: false,
                  smsError: smsResult.error
                });
              }
            } else {
              console.warn(`⚠️ No phone number found for call ${callControlId}, cannot send SMS`);
              // No phone number -> update status to "completed"
              await firebaseService.updateCallStatus(callControlId, 'completed', {
                hangupCause: hangupCause,
                duration: callDuration,
                endTime: new Date(),
                isShortDuration: callDuration < MIN_ANSWERED_DURATION_SECS
              });
            }
          } catch (smsError) {
            console.error(`❌ Error processing SMS for call ${callControlId}:`, smsError);
            // SMS error -> update status to "failed"
            await firebaseService.updateCallStatus(callControlId, 'completed', {
              hangupCause: hangupCause,
              duration: callDuration,
              endTime: new Date(),
              isShortDuration: callDuration < MIN_ANSWERED_DURATION_SECS,
              smsSent: false,
              smsError: smsError.message
            });
          }
        } else {
          // Update status without SMS for other hangup causes
          await firebaseService.updateCallStatus(callControlId, status, {
            hangupCause: hangupCause,
            duration: callDuration,
            endTime: new Date(),
            isShortDuration: callDuration < MIN_ANSWERED_DURATION_SECS
          });
        }
        break;

      case 'call.speak.ended':
        await firebaseService.updateCallStatus(callControlId, 'completed');
        break;

      case 'call.bridged':
        await firebaseService.updateCallStatus(callControlId, 'in-progress');
        break;

      default:
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