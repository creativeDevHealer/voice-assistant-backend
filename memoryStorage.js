// Shared in-memory storage for testing (temporary replacement for Firebase)
const callStorage = new Map();
const activeCallSids = new Set();

const memoryService = {
  async storeCallData(callControlId, callData) {
    callStorage.set(callControlId, { ...callData, createdAt: new Date(), updatedAt: new Date() });
    activeCallSids.add(callControlId);
    console.log(`Stored call data for ${callControlId} (in-memory)`);
    return true;
  },
  
  async getCallData(callControlId) {
    const data = callStorage.get(callControlId);
    return data ? { callSid: callControlId, ...data } : null;
  },
  
  async updateCallStatus(callControlId, status, additionalData = {}) {
    const existing = callStorage.get(callControlId);
    if (existing) {
      callStorage.set(callControlId, { ...existing, status, ...additionalData, updatedAt: new Date() });
      console.log(`Updated call status for ${callControlId}: ${status} (in-memory)`);
    } else {
      // Create new entry if it doesn't exist
      callStorage.set(callControlId, { status, ...additionalData, createdAt: new Date(), updatedAt: new Date() });
      console.log(`Created new call entry for ${callControlId}: ${status} (in-memory)`);
    }
    return true;
  },
  
  async storeBroadcastSession(broadcastId, sessionData) {
    callStorage.set(`broadcast_${broadcastId}`, { ...sessionData, createdAt: new Date() });
    console.log(`Stored broadcast session: ${broadcastId} (in-memory)`);
    return true;
  },
  
  async getCallCounts(broadcastId = null) {
    const calls = Array.from(callStorage.values()).filter(item => !item.totalCalls); // Filter out broadcast sessions
    
    const counts = {
      total: calls.length,
      pending: calls.filter(c => c.status === 'pending').length,
      completed: calls.filter(c => ['completed', 'answered', 'voicemail'].includes(c.status)).length,
      failed: calls.filter(c => ['failed', 'no-answer', 'busy', 'canceled'].includes(c.status)).length,
      ringing: calls.filter(c => c.status === 'ringing').length
    };
    
    counts.totalCompleted = counts.completed;
    counts.totalFailed = counts.failed;
    
    return counts;
  },
  
  async getActiveCalls() {
    return Array.from(callStorage.entries())
      .filter(([key, value]) => ['pending', 'ringing'].includes(value.status))
      .map(([key, value]) => ({ callControlId: key, ...value }));
  },
  
  async cancelBroadcastCalls(broadcastId) {
    let count = 0;
    for (const [key, value] of callStorage.entries()) {
      if (value.broadcastId === broadcastId && ['pending', 'ringing'].includes(value.status)) {
        callStorage.set(key, { ...value, status: 'canceled', updatedAt: new Date() });
        count++;
      }
    }
    return count;
  },

  // Debug method to see all stored data
  getAllData() {
    return Object.fromEntries(callStorage);
  }
};

module.exports = memoryService;
