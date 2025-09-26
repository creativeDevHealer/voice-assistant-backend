const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  try {
    // Try to initialize with service account key if available
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
        // No databaseURL needed for Firestore
      });
    } else {
      // For development, you can use a service account key file
      // Make sure to add your firebase-service-account.json file to the backend folder
      // and add it to .gitignore for security
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
        // No databaseURL needed for Firestore
      });
    }
    // console.log('Firebase Admin SDK initialized successfully');
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
  }
}

const db = admin.firestore();

// Helper function to remove undefined values from objects
function cleanUndefinedValues(obj) {
  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

class FirebaseService {
  // Store call data in Firebase
  async storeCallData(callControlId, callData) {
    try {
      const docRef = db.collection('calls').doc(callControlId);
      
      // Clean undefined values to prevent Firestore errors
      const cleanedData = cleanUndefinedValues(callData);
      
      await docRef.set({
        ...cleanedData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // console.log(`Call data stored for ${callControlId}`);
      return true;
    } catch (error) {
      console.error('Error storing call data:', error);
      throw error;
    }
  }

  // Update call status in Firebase
  async updateCallStatus(callControlId, status, additionalData = {}) {
    try {
      const docRef = db.collection('calls').doc(callControlId);
      
      // Clean undefined values to prevent Firestore errors
      const cleanedData = cleanUndefinedValues({
        status: status,
        ...additionalData
      });
      
      // Debug: Log what we're trying to update
      // console.log(`Updating call ${callControlId} with:`, JSON.stringify(cleanedData, null, 2));
      
      // Check if document exists first
      const doc = await docRef.get();
      
      if (doc.exists) {
        // Document exists, update it
        await docRef.update({
          ...cleanedData,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Document doesn't exist, create it
        console.log(`Document for ${callControlId} doesn't exist, creating it...`);
        await docRef.set({
          callControlId: callControlId,
          ...cleanedData,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      
      // console.log(`✅ Call status updated for ${callControlId}: ${status}`);
      return true;
    } catch (error) {
      console.error('Error updating call status:', error);
      throw error;
    }
  }

  // Get call data by call control ID
  async getCallData(callControlId) {
    try {
      const doc = await db.collection('calls').doc(callControlId).get();
      if (doc.exists) {
        return {
          callSid: callControlId,
          ...doc.data()
        };
      }
      return null;
    } catch (error) {
      console.error('Error getting call data:', error);
      throw error;
    }
  }

  // Get call counts by status
  async getCallCounts(broadcastId = null) {
    try {
      let query = db.collection('calls');
      
      if (broadcastId) {
        query = query.where('broadcastId', '==', broadcastId);
      }

      const snapshot = await query.get();
      
      const counts = {
        total: snapshot.size,
        pending: 0,
        ringing: 0,
        answered: 0,
        completed: 0,
        failed: 0,
        'no-answer': 0,
        busy: 0,
        canceled: 0,
        voicemail: 0
      };

      snapshot.forEach(doc => {
        const data = doc.data();
        const status = data.status || 'pending';
        if (counts.hasOwnProperty(status)) {
          counts[status]++;
        }
      });

      // Calculate aggregate counts
      const completedStatuses = ['completed', 'answered', 'voicemail', 'busy'];
      const failedStatuses = ['failed', 'no-answer', 'canceled'];
      
      counts.totalCompleted = completedStatuses.reduce((sum, status) => sum + counts[status], 0);
      counts.totalFailed = failedStatuses.reduce((sum, status) => sum + counts[status], 0);
      counts.totalPending = counts.pending + counts.ringing;

      return counts;
    } catch (error) {
      console.error('Error getting call counts:', error);
      throw error;
    }
  }

  // Store broadcast session data
  async storeBroadcastSession(broadcastId, sessionData) {
    try {
      const docRef = db.collection('broadcasts').doc(broadcastId);
      
      // Clean undefined values to prevent Firestore errors
      const cleanedData = cleanUndefinedValues(sessionData);
      
      await docRef.set({
        ...cleanedData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // console.log(`Broadcast session stored: ${broadcastId}`);
      return true;
    } catch (error) {
      console.error('Error storing broadcast session:', error);
      throw error;
    }
  }

  // Update broadcast session
  async updateBroadcastSession(broadcastId, updateData) {
    try {
      const docRef = db.collection('broadcasts').doc(broadcastId);
      
      // Clean undefined values to prevent Firestore errors
      const cleanedData = cleanUndefinedValues(updateData);
      
      await docRef.update({
        ...cleanedData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // console.log(`Broadcast session updated: ${broadcastId}`);
      return true;
    } catch (error) {
      console.error('Error updating broadcast session:', error);
      throw error;
    }
  }

  // Get all calls for a broadcast
  async getBroadcastCalls(broadcastId) {
    try {
      const snapshot = await db.collection('calls')
        .where('broadcastId', '==', broadcastId)
        .get();
      
      const calls = [];
      snapshot.forEach(doc => {
        calls.push({
          callControlId: doc.id,
          callSid: doc.id, // Add callSid for consistency
          ...doc.data()
        });
      });
      
      return calls;
    } catch (error) {
      console.error('Error getting broadcast calls:', error);
      throw error;
    }
  }

  // Cancel all calls for a broadcast
  async cancelBroadcastCalls(broadcastId) {
    try {
      const batch = db.batch();
      const snapshot = await db.collection('calls')
        .where('broadcastId', '==', broadcastId)
        .where('status', 'in', ['pending', 'ringing'])
        .get();
      
      snapshot.forEach(doc => {
        batch.update(doc.ref, {
          status: 'canceled',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      
      await batch.commit();
      // console.log(`Canceled ${snapshot.size} calls for broadcast ${broadcastId}`);
      return snapshot.size;
    } catch (error) {
      console.error('Error canceling broadcast calls:', error);
      throw error;
    }
  }

  // Get all active calls (pending or ringing)
  async getActiveCalls() {
    try {
      const snapshot = await db.collection('calls')
        .where('status', 'in', ['pending', 'ringing'])
        .get();
      
      const activeCalls = [];
      snapshot.forEach(doc => {
        activeCalls.push({
          callControlId: doc.id,
          callSid: doc.id, // Add callSid for consistency
          ...doc.data()
        });
      });
      
      return activeCalls;
    } catch (error) {
      console.error('Error getting active calls:', error);
      
      // If quota exceeded, return empty array to prevent system crash
      if (error.code === 8 || error.message?.includes('RESOURCE_EXHAUSTED')) {
        console.warn('⚠️ Firebase quota exceeded in getActiveCalls, returning empty array');
        return [];
      }
      
      throw error;
    }
  }
}

module.exports = new FirebaseService();
