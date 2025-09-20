# AID Kitty 🐱

An AI-powered MVP generator that helps you create comprehensive project plans and documentation using multiple LLM providers.

## Features

- **Multi-LLM Integration**: Support for OpenAI, Anthropic, Google, and DeepSeek AI providers
- **Document Processing**: Upload and analyze PDF documents and text files
- **MVP Generation**: Generate detailed MVP plans with AI assistance
- **Project Management**: Organize and track your projects
- **Modern UI**: Beautiful, responsive React frontend with Tailwind CSS
- **Authentication**: Secure user registration and login

## Tech Stack

### Backend
- Node.js with Express
- TypeScript
- SQLite with Drizzle ORM
- JWT Authentication
- Multer for file uploads
- PDF parsing capabilities

### Frontend
- React 18 with TypeScript
- Vite for build tooling
- Tailwind CSS for styling
- Radix UI components
- React Query for data fetching
- Wouter for routing

## Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd aid-kitty
   ```

2. **Install backend dependencies**
   ```bash
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd client
   npm install
   cd ..
   ```

4. **Set up environment variables**
   
   Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```
   
   Required environment variables:
   ```
   DATABASE_PATH=./data/app.db
   PORT=3001
   JWT_SECRET=your-jwt-secret-key
   OPENAI_API_KEY=your-openai-key
   ANTHROPIC_API_KEY=your-anthropic-key
   GOOGLE_API_KEY=your-google-key
   DEEPSEEK_API_KEY=your-deepseek-key
   ```

5. **Initialize the database**
   ```bash
   npm run db:generate
   npm run db:migrate
   ```

### Development

1. **Start the backend server**
   ```bash
   npm run dev
   ```
   The API will be available at `http://localhost:3001`

2. **Start the frontend development server**
   ```bash
   cd client
   npm run dev
   ```
   The frontend will be available at `http://localhost:5173`

### API Endpoints

- `GET /` - API documentation
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `GET /api/auth/me` - Get current user
- `GET /api/projects` - List user projects
- `POST /api/projects` - Create new project
- `POST /api/upload` - Upload files
- `POST /api/generate-mvp` - Generate MVP plan
- `GET /api/providers` - List available AI providers

### Project Structure

```
aid-kitty/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/     # Reusable UI components
│   │   ├── pages/          # Page components
│   │   ├── lib/            # Utilities and contexts
│   │   └── hooks/          # Custom React hooks
│   ├── public/             # Static assets
│   └── package.json        # Frontend dependencies
├── server/                 # Express backend
│   ├── routes/             # API route handlers
│   ├── utils/              # Utility functions
│   └── index.ts            # Server entry point
├── migrations/             # Database migrations
├── data/                   # SQLite database and uploads
├── package.json            # Backend dependencies
└── drizzle.config.ts       # Database configuration
```

## Usage

1. **Register an account** or login if you already have one
2. **Create a new project** from the dashboard
3. **Upload documents** (PDF or text files) with your requirements
4. **Select an AI provider** (OpenAI, Anthropic, Google, or DeepSeek)
5. **Generate your MVP plan** and review the results
6. **Manage your projects** from the projects page

## AI Providers

AID Kitty supports multiple AI providers:

- **OpenAI**: GPT-4 and GPT-3.5 models
- **Anthropic**: Claude models
- **Google**: Gemini models  
- **DeepSeek**: DeepSeek models

Each provider offers different strengths for MVP generation and planning.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

If you encounter any issues or have questions, please open an issue on GitHub.
