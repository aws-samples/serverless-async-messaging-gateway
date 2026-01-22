# Product Overview

Serverless Async Messaging Gateway - A serverless solution for managing asynchronous messages, responses, and notifications from long-running tasks.

## Purpose
Delivers real-time messages to clients via WebSockets while handling offline scenarios by storing and replaying messages when clients reconnect.

## Core Components
1. **Messaging Gateway** - Receives messages from backend systems and delivers them to connected clients via WebSocket
2. **Authentication** - Cognito-based auth with single-use temporary tokens for WebSocket connections
3. **Sample Application** - Demo app simulating long-running async tasks

## Key Features
- WebSocket-based real-time message delivery
- Message persistence for offline clients with automatic replay on reconnect
- FIFO message ordering per user
- Single-use encrypted tokens for secure WebSocket authentication
- IAM-authorized message ingestion API
