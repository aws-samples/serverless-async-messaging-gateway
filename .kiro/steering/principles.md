# Development Principles

## DRY (Don't Repeat Yourself)
- Extract shared logic into `lib/utils.ts`
- Reuse CDK patterns across constructs
- Centralize configuration (environment variables, context values)

## KISS (Keep It Simple, Stupid)
- Prefer straightforward solutions over clever abstractions
- Use native AWS service integrations when possible (e.g., API Gateway → DynamoDB direct integration)
- Minimize Lambda code by leveraging Step Functions for orchestration

## SOLID
- **Single Responsibility**: Each construct handles one component (Gateway, Authentication, Application)
- **Open/Closed**: Extend via props and composition, not modification
- **Liskov Substitution**: Use CDK interfaces (`IFunction`, `ITable`) for flexibility
- **Interface Segregation**: Expose only necessary public methods on constructs
- **Dependency Inversion**: Pass dependencies via constructor props

## YAGNI (You Aren't Gonna Need It)
- Don't add features until they're required
- Avoid premature optimization
- Keep Lambda handlers focused on their specific task

## Boy Scout Rule
- Leave code cleaner than you found it
- Fix small issues (typos, formatting, outdated comments) when touching a file
- Refactor incrementally rather than in large rewrites
