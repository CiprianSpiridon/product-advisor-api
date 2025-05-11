# Product Assistant API

A RAG-based (Retrieval-Augmented Generation) product recommendation API that leverages OpenAI's models, vector embeddings, and product data to provide personalized product recommendations and answer product-related questions.

## Features

- **Conversational Product Assistant**: Answer questions about products and provide relevant product recommendations
- **Personalization**: Incorporate user profile and children information into responses
- **Memory**: Maintain conversation history and periodically summarize for long-term context
- **Caching**: Store and retrieve previous responses to improve performance
- **Vector Search**: Utilize embeddings for semantic product search using Qdrant
- **MongoDB Storage**: Persist conversations, memory, and cache data

## Architecture

The application follows a modular architecture separating concerns:

```
product-assitant-api/
├── config/                # Configuration files (app.json, prompts.json)
├── docker/                # Docker-related files
│   ├── app/               # Application Dockerfile
│   └── data/              # Data persistence (MongoDB, Qdrant)
├── input_data/            # Source data for embeddings
├── packages/              # Local dependencies
│   └── embedjs-mongodb/   # MongoDB integration for embedjs
├── src/                   # Application source code (refactored)
│   ├── config/            # Configuration loading and management
│   ├── controllers/       # Request handlers
│   ├── middleware/        # Express middleware
│   ├── routes/            # API route definitions
│   ├── services/          # Business logic and service layer
│   └── utils/             # Utility functions
├── db.mjs                 # Database connection and product retrieval
├── generate-embeddings.mjs # Script to generate vector embeddings
├── index.mjs              # Legacy entry point
└── docker-compose.yml     # Docker services configuration
```

### Key Components

- **Config Service**: Centralizes loading of environment variables and JSON configuration
- **RAG Service**: Manages RAG application setup, vector database connections, and LLM queries
- **Cache Service**: Handles caching of query responses
- **Memory Service**: Manages conversation history and long-term memory
- **Chat Controller**: Processes user queries and orchestrates the services

## Setup and Installation

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for containerized deployment)
- OpenAI API key
- MongoDB
- Qdrant vector database

### Environment Setup

1. Clone the repository
2. Copy `example.env` to `.env` and fill in the required values:
   ```
   cp example.env .env
   ```
3. Install dependencies:
   ```
   npm install
   ```

### Running the Application

#### Development Mode

```bash
# Generate embeddings (first time only)
npm run generate-embeddings

# Start the server in development mode with auto-reload
npm run dev:new
```

#### Production Mode

```bash
# Start the server in production mode
npm run start:new
```

#### Docker Deployment

```bash
# Build and start all services with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f app
```

## API Endpoints

### Health Check

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2023-05-01T12:00:00.000Z"
}
```

### Chat API

```
POST /chat
POST /ask
```

Request Body:
```json
{
  "query": "Can you recommend baby strollers?",
  "userId": "user123",
  "user": {
    "name": "John Doe",
    "children": [
      {
        "name": "Jane",
        "age": "2",
        "gender": "female"
      }
    ]
  }
}
```

Response:
```json
{
  "answer": "Based on your needs with a 2-year-old daughter, I'd recommend...",
  "relatedProducts": [
    {
      "sku": "ST-102",
      "name": "Lightweight Travel Stroller",
      "price": 199.99,
      "category": "Baby",
      "description": "..."
    }
  ]
}
```

## Data Flow

```
┌─────────┐       ┌───────────────┐       ┌────────────────┐       ┌────────────────┐
│  User   │       │   API Routes  │       │ ChatController │       │ Cache Service  │
│ Request ├───────► /ask or /chat ├───────► handleQuery()  ├───────► Check Cache    │
└─────────┘       └───────────────┘       └────────┬───────┘       └────┬───────────┘
                                                   │                    │
                                                   │   Cache Miss       │
                                                   ▼                    │
┌──────────────────┐       ┌────────────────┐     │                    │
│ Product Database │       │ Memory Service │◄────┘                    │
│ (MongoDB)        │◄──────┤ - Conversation │                          │
└──────────────────┘       │ - Memory       │                          │
         ▲                 └────────┬───────┘                          │
         │                          │                                  │
         │                          ▼                                  │
         │              ┌────────────────────┐                         │
         │              │ Build Prompt with:  │                         │
         │              │ - User context      │                         │
         │              │ - Memory            │                         │
         │              │ - Conversation      │                         │
         │              └──────────┬─────────┘                         │
         │                         │                                   │
         │                         ▼                                   │
┌────────┴───────┐     ┌────────────────┐                             │
│ Get Product    │     │  RAG Service   │                             │
│ Details        │◄────┤  Query LLM     │                             │
└────────────────┘     └───────┬────────┘                             │
                               │                                      │
                               ▼                                      │
                       ┌────────────────┐                             │
                       │  Vector Search │                             │
                       │  (Qdrant)      │                             │
                       └───────┬────────┘                             │
                               │                                      │
                               ▼                                      │
                       ┌────────────────┐        ┌──────────────┐     │
                       │ JSON Response  │        │ Save to Cache │     │
                       │ Construction   ├────────► & Update      │     │
                       └───────┬────────┘        │ Conversation  │     │
                               │                 └──────┬────────┘     │
                               │                        │              │
                               ▼                        │      Cache Hit
                       ┌────────────────┐               │              │
                       │ Response sent  │◄──────────────┴──────────────┘
                       │ to User        │
                       └────────────────┘
```

1. User sends a query to the API
2. System checks cache for existing response
3. If not cached, the query is processed:
   - User's conversation history is retrieved
   - Long-term memory/summaries are incorporated
   - A prompt is constructed with all context
   - The prompt is sent to the LLM through the RAG system
   - Products mentioned in the response are enriched with details
4. Response is cached and returned to the user
5. Conversation history is updated

## Development

### File Structure Details

- **src/config/index.js**: Configuration loading from environment and JSON files
- **src/services/ragService.js**: RAG application setup and query handling
- **src/services/cacheService.js**: Response caching functionality
- **src/services/memoryService.js**: Conversation and memory management
- **src/controllers/chatController.js**: Request processing logic
- **src/routes/index.js**: API endpoint definitions
- **src/utils/network.js**: Network utility functions
- **src/index.js**: Application entry point

### Adding New Features

1. For new API endpoints:
   - Add route handlers to `src/routes/`
   - Create new controllers in `src/controllers/`

2. For new functionality:
   - Add service modules in `src/services/`
   - Update existing services as needed

## Migrating from Legacy to New Architecture

The application supports both the legacy (index.mjs) and new (src/index.js) architectures. To migrate:

1. Test the new architecture:
   ```
   npm run dev:new
   ```

2. Update your Docker setup:
   Change `CMD ["node", "index.mjs"]` to `CMD ["node", "src/index.js"]` in your Dockerfile

3. Deploy the new version:
   ```
   npm run start:new
   ```

## License

ISC 