import ragService from './ragService.js';

class MemoryService {
  constructor() {
    this.mongoStore = null;
  }

  initialize(mongoStore) {
    this.mongoStore = mongoStore;
  }

  async getConversationMemory(userId) {
    if (!this.mongoStore) {
      console.error("Memory service not initialized with MongoStore");
      return "";
    }

    let longTermMemoryContext = "";
    const memoryKeyForLastSummary = `memory:${userId}:last_summary`;
    
    try {
      console.log(`Attempting to get last summary memory with key: ${memoryKeyForLastSummary}`);
      const lastSummaryMemory = await this.mongoStore.loaderCustomGet(memoryKeyForLastSummary);
      
      if (lastSummaryMemory && lastSummaryMemory.text) {
        longTermMemoryContext = lastSummaryMemory.text;
        console.log(`Retrieved last summary for longTermMemoryContext.`);
      } else {
        console.log(`No last summary found or no text in memory for longTermMemoryContext.`);
      }
    } catch (memoryGetError) {
      console.warn(`Error during mongoStore.loaderCustomGet for memory: ${memoryGetError.message}`);
    }

    return longTermMemoryContext;
  }

  async getConversationHistory(userId) {
    if (!this.mongoStore) {
      console.error("Memory service not initialized with MongoStore");
      return { conversationId: userId, entries: [] };
    }

    console.log(`Checking conversation history for conversationId: ${userId}`);
    let conversationData = null;
    
    try {
      const conversationExists = await this.mongoStore.hasConversation(userId);

      if (conversationExists) {
        console.log(`Existing conversation found for ${userId}. Fetching...`);
        conversationData = await this.mongoStore.getConversation(userId); 
      } else {
        console.log(`No existing conversation found for ${userId}. Creating new one.`);
        if (typeof this.mongoStore.addConversation === 'function') {
          await this.mongoStore.addConversation(userId); 
          conversationData = await this.mongoStore.getConversation(userId); 
          if (!conversationData) {
            console.error(`Failed to retrieve conversation immediately after adding for ${userId}. Initializing locally.`);
            conversationData = { conversationId: userId, entries: [] }; 
          }
        } else {
          console.error(`mongoStore.addConversation is not a function! Cannot create new conversation.`);
          conversationData = { conversationId: userId, entries: [] };
        }
      }
    } catch (error) {
      console.error(`Error fetching conversation history: ${error.message}`);
      conversationData = { conversationId: userId, entries: [] };
    }
    
    return conversationData;
  }

  async addConversationEntries(userId, userQuery, botResponse) {
    if (!this.mongoStore || typeof this.mongoStore.addEntryToConversation !== 'function') {
      console.error("Memory service not initialized with MongoStore or addEntryToConversation unavailable");
      return false;
    }

    try {
      console.log(`Adding user turn to conversation ${userId}`);
      await this.mongoStore.addEntryToConversation(userId, {
        role: 'User',
        content: userQuery,
        timestamp: new Date()
      });

      console.log(`Adding bot turn to conversation ${userId}`);
      await this.mongoStore.addEntryToConversation(userId, {
        role: 'Bot',
        content: botResponse,
        timestamp: new Date()
      });
      
      return true;
    } catch (error) {
      console.error(`Error adding conversation entries: ${error.message}`);
      return false;
    }
  }

  async summarizeAndStoreMemory(userId, ragService, promptTemplate) {
    if (!this.mongoStore) {
      console.error("Memory service not initialized with MongoStore");
      return false;
    }

    try {
      const conversationData = await this.mongoStore.getConversation(userId);
      const historyEntries = conversationData && conversationData.entries ? conversationData.entries : [];

      if (historyEntries.length > 0 && historyEntries.length % 10 === 0) {
        const historyTextForSummary = historyEntries.map(turn => `${turn.role}: ${turn.content}`).join("\n");
        console.log(`Summarizing conversation for ${userId}`);
        
        const summary = await ragService.summarizeConversation(userId, historyTextForSummary, promptTemplate);
        
        if (summary && !summary.startsWith("Error") && !summary.startsWith("Could not summarize")) {
          const memoryKeyForLastSummary = `memory:${userId}:last_summary`;
          
          if (typeof this.mongoStore.loaderCustomSet === 'function') {
            console.log(`Adding memory (summary) for ${userId} with key: ${memoryKeyForLastSummary}`);
            await this.mongoStore.loaderCustomSet(userId, memoryKeyForLastSummary, {
              text: summary,
              type: 'conversation_summary',
              timestamp: new Date()
            });
            return true;
          } else {
            console.error(`mongoStore.loaderCustomSet is not a function! Cannot save memory (summary).`);
          }
        }
      }
      
      return false;
    } catch (error) {
      console.error(`Error summarizing and storing memory: ${error.message}`);
      return false;
    }
  }
}

// Singleton instance
const memoryService = new MemoryService();
export default memoryService; 