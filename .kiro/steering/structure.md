# Project Structure

```
├── lib/                          # Source code
│   ├── serverless-async-messaging-gateway-stack.ts  # Main CDK stack
│   ├── gateway.ts                # Messaging gateway construct
│   ├── gateway.SendUnsentMessages.mjs  # Lambda: replay pending messages
│   ├── authentication.ts         # Auth construct (Cognito + temp tokens)
│   ├── authentication.Generator.mjs    # Lambda: generate temp tokens
│   ├── authentication.Authorizer.mjs   # Lambda: WebSocket authorizer
│   ├── application.ts            # Sample app construct
│   ├── application.sample.cjs    # Lambda: sample async task
│   └── utils.ts                  # Shared utilities
├── assets/
│   └── SendMessage.asl           # Step Functions workflow (ASL)
├── bin/                          # CDK app entry point & CLI tools
├── img/                          # Architecture diagrams
├── cdk.json                      # CDK configuration
├── tsconfig.json                 # TypeScript config
└── package.json                  # Dependencies
```

## Naming Conventions

### CDK Constructs (`lib/*.ts`)
- PascalCase class names matching component purpose
- Private methods prefixed with `create` for resource creation
- JSDoc comments on public APIs

### Lambda Functions (`lib/*.mjs`)
- Named `<construct>.<function>.mjs`
- ESM format with `export` syntax
- Export `handler` function
- Use Powertools Logger for structured logging

### Step Functions (`assets/*.asl`)
- Amazon States Language JSON files
- Use `${Variable}` placeholders for CDK substitutions

## Architecture Patterns
- Each major component is a separate CDK Construct
- Lambda functions bundled with esbuild (minified, source maps)
- External modules excluded from bundle (SDK, Powertools)
- DynamoDB streams trigger Lambda for event-driven processing
- EventBridge Pipes connect SQS to Step Functions
