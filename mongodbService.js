const { MongoClient, ObjectId } = require('mongodb');

// MongoDB connection configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = process.env.MONGODB_DATABASE || 'callservice';

class MongoDBService {
  constructor() {
    this.client = null;
    this.db = null;
    this.isConnected = false;
  }

  // Initialize MongoDB connection
  async connect() {
    try {
      if (!this.isConnected) {
        this.client = new MongoClient(MONGODB_URI);
        await this.client.connect();
        this.db = this.client.db(DATABASE_NAME);
        this.isConnected = true;
        console.log('✅ MongoDB connected successfully');
      }
      return this.db;
    } catch (error) {
      console.error('❌ MongoDB connection error:', error);
      throw error;
    }
  }

  // Helper function to remove undefined values from objects
  cleanUndefinedValues(obj) {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  // Store call data in MongoDB
  async storeCallData(callControlId, callData) {
    try {
      await this.connect();
      const collection = this.db.collection('calls');
      
      // Clean undefined values
      const cleanedData = this.cleanUndefinedValues(callData);
      
      const document = {
        _id: callControlId,
        ...cleanedData,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await collection.replaceOne(
        { _id: callControlId },
        document,
        { upsert: true }
      );
      
      return true;
    } catch (error) {
      console.error('Error storing call data:', error);
      throw error;
    }
  }

  // Update call status in MongoDB
  async updateCallStatus(callControlId, status, additionalData = {}) {
    try {
      await this.connect();
      const collection = this.db.collection('calls');
      
      // Clean undefined values
      const cleanedData = this.cleanUndefinedValues({
        status: status,
        ...additionalData
      });
      
      const updateData = {
        ...cleanedData,
        updatedAt: new Date()
      };

      const result = await collection.updateOne(
        { _id: callControlId },
        { $set: updateData },
        { upsert: true }
      );

      return true;
    } catch (error) {
      console.error('Error updating call status:', error);
      throw error;
    }
  }

  // Get call data by call control ID
  async getCallData(callControlId) {
    try {
      await this.connect();
      const collection = this.db.collection('calls');
      
      const document = await collection.findOne({ _id: callControlId });
      if (document) {
        return {
          callSid: callControlId,
          ...document
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
      await this.connect();
      const collection = this.db.collection('calls');
      
      // Build match criteria
      const matchCriteria = {};
      if (broadcastId) {
        matchCriteria.broadcastId = broadcastId;
      }

      // Aggregate pipeline to get counts by status
      const pipeline = [
        { $match: matchCriteria },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ];

      const results = await collection.aggregate(pipeline).toArray();
      
      // Initialize counts object
      const counts = {
        total: 0,
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

      // Process aggregation results
      results.forEach(result => {
        const status = result._id || 'pending';
        if (counts.hasOwnProperty(status)) {
          counts[status] = result.count;
        }
        counts.total += result.count;
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
      await this.connect();
      const collection = this.db.collection('broadcasts');
      
      // Clean undefined values
      const cleanedData = this.cleanUndefinedValues(sessionData);
      
      const document = {
        _id: broadcastId,
        ...cleanedData,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await collection.replaceOne(
        { _id: broadcastId },
        document,
        { upsert: true }
      );
      
      return true;
    } catch (error) {
      console.error('Error storing broadcast session:', error);
      throw error;
    }
  }

  // Update broadcast session
  async updateBroadcastSession(broadcastId, updateData) {
    try {
      await this.connect();
      const collection = this.db.collection('broadcasts');
      
      // Clean undefined values
      const cleanedData = this.cleanUndefinedValues(updateData);
      
      const updateDocument = {
        ...cleanedData,
        updatedAt: new Date()
      };

      await collection.updateOne(
        { _id: broadcastId },
        { $set: updateDocument },
        { upsert: true }
      );
      
      return true;
    } catch (error) {
      console.error('Error updating broadcast session:', error);
      throw error;
    }
  }

  // Get all calls for a broadcast
  async getBroadcastCalls(broadcastId) {
    try {
      await this.connect();
      const collection = this.db.collection('calls');
      
      const calls = await collection.find({ broadcastId: broadcastId }).toArray();
      
      return calls.map(call => ({
        callControlId: call._id,
        callSid: call._id, // Add callSid for consistency
        ...call
      }));
    } catch (error) {
      console.error('Error getting broadcast calls:', error);
      throw error;
    }
  }

  // Cancel all calls for a broadcast
  async cancelBroadcastCalls(broadcastId) {
    try {
      await this.connect();
      const collection = this.db.collection('calls');
      
      const result = await collection.updateMany(
        { 
          broadcastId: broadcastId,
          status: { $in: ['pending', 'ringing'] }
        },
        { 
          $set: { 
            status: 'canceled',
            updatedAt: new Date()
          }
        }
      );
      
      return result.modifiedCount;
    } catch (error) {
      console.error('Error canceling broadcast calls:', error);
      throw error;
    }
  }

  // Get all active calls (pending or ringing)
  async getActiveCalls() {
    try {
      await this.connect();
      const collection = this.db.collection('calls');
      
      const activeCalls = await collection.find({
        status: { $in: ['pending', 'ringing'] }
      }).toArray();
      
      return activeCalls.map(call => ({
        callControlId: call._id,
        callSid: call._id, // Add callSid for consistency
        ...call
      }));
    } catch (error) {
      console.error('Error getting active calls:', error);
      throw error;
    }
  }

  // Close MongoDB connection
  async close() {
    try {
      if (this.client && this.isConnected) {
        await this.client.close();
        this.isConnected = false;
        console.log('✅ MongoDB connection closed');
      }
    } catch (error) {
      console.error('Error closing MongoDB connection:', error);
    }
  }
}

module.exports = new MongoDBService();
