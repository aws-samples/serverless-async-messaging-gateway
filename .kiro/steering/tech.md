# Tech Stack

## Infrastructure
- **AWS CDK v2** (TypeScript) - Infrastructure as Code
- **cdk-nag** - Security and best practices validation

## AWS Services
- API Gateway (REST + WebSocket)
- Lambda (Node.js 24, ARM64)
- DynamoDB (on-demand billing)
- SQS FIFO queues
- Step Functions (Express workflows)
- EventBridge Pipes
- Cognito User Pools
- KMS (token encryption)
- CloudWatch Logs

## Languages & Runtime
- TypeScript for CDK constructs
- JavaScript (ESM `.mjs`) for Lambda functions
- Node.js 24.x runtime

## Key Libraries
- `aws-cdk-lib` - CDK constructs
- `@aws-lambda-powertools/logger` - Structured logging
- `@aws-sdk/*` - AWS SDK v3 clients (includes `@smithy/signature-v4` for request signing)

## Common Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode for development
npm run watch

# Deploy stack
cdk deploy

# Deploy with destroy-all context (for dev/test)
cdk deploy -c destroy-all=true

# Destroy stack
cdk destroy

# Run CDK commands
npm run cdk -- <command>
```

## CDK Context Options
- `destroy-all` - Sets RemovalPolicy.DESTROY on resources
- `api-log-level` - API Gateway logging (ERROR, INFO, FULL)
- `max-message-size` - Maximum message payload size
