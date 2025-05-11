import ragService from './ragService.js';

class CacheService {
  constructor() {
    this.mongoStore = null;
  }

  initialize(mongoStore) {
    this.mongoStore = mongoStore;
  }

  // Generate a consistent cache key
  generateCacheKey(userId, query, userMetadata) {
    const metadataString = JSON.stringify(userMetadata || {});
    return `cache:${userId}:${query}:${metadataString}`; 
  }

  async getCachedResult(userId, query, userMetadata) {
    if (!this.mongoStore) {
      console.error("Cache service not initialized with MongoStore");
      return null;
    }

    const cacheKey = this.generateCacheKey(userId, query, userMetadata);
    let cachedResultDocument = null;

    try {
      console.log(`Attempting to get cache with key: ${cacheKey}`);
      cachedResultDocument = await this.mongoStore.loaderCustomGet(cacheKey);
    } catch (cacheGetError) {
      console.warn(`Error during mongoStore.loaderCustomGet for cache (treating as cache miss): ${cacheGetError.message}`);
      return null;
    }

    if (cachedResultDocument && cachedResultDocument.data) {
      console.log(`MongoStore cache hit for query: "${query.substring(0, 30)}..." by user ${userId}`);
      return cachedResultDocument.data;
    }

    console.log(`Cache miss for key (or error during fetch/no data property): ${cacheKey}`);
    return null;
  }

  async setCachedResult(userId, query, userMetadata, data) {
    if (!this.mongoStore) {
      console.error("Cache service not initialized with MongoStore");
      return false;
    }

    if (typeof this.mongoStore.loaderCustomSet !== 'function') {
      console.error("mongoStore.loaderCustomSet is not a function! Cannot save to cache.");
      return false;
    }

    const cacheKey = this.generateCacheKey(userId, query, userMetadata);
    try {
      console.log(`Setting cache with key: ${cacheKey}`);
      await this.mongoStore.loaderCustomSet(userId, cacheKey, { data, timestamp: new Date() });
      return true;
    } catch (error) {
      console.error(`Error setting cache: ${error.message}`);
      return false;
    }
  }
}

// Singleton instance
const cacheService = new CacheService();
export default cacheService; 