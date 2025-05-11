# Product Assistant API - Refactored Architecture

This is a refactored version of the product assistant API with a proper file structure.

## Directory Structure

```
src/
├── config/       # Configuration loading and management
├── controllers/  # Request handlers
├── middleware/   # Express middleware
├── routes/       # API route definitions
├── services/     # Business logic and service layer
└── utils/        # Utility functions
```

## Key Components

- **Config**: Centralizes loading of environment variables and JSON configuration files
- **RagService**: Handles RAG application setup and LLM queries
- **CacheService**: Manages caching of query responses
- **MemoryService**: Handles conversation history and memory management
- **ChatController**: Processes chat queries and orchestrates services

## Running the Application

To run this refactored version:

```bash
# Install dependencies
npm install

# Start the server using the new structure
npm run dev:new

# Or in production mode
npm run start:new
```

## Enhancements

1. **Modularity**: Functionality is separated into distinct modules with clear responsibilities
2. **Maintainability**: Easier to understand, debug, and extend
3. **Testability**: Components can be tested in isolation
4. **Reusability**: Services can be reused across different controllers and routes

## Migration

This refactored version maintains full compatibility with the original API. The original index.mjs is kept for reference, but new development should use this structure. 