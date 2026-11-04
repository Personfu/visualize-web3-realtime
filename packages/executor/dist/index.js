import { ExecutorServer } from './ExecutorServer.js';
const config = {
    port: parseInt(process.env['EXECUTOR_PORT'] ?? '8765', 10),
    host: process.env['EXECUTOR_HOST'] ?? '127.0.0.1',
    accessToken: process.env['EXECUTOR_ACCESS_TOKEN'] ?? '',
    viewerToken: process.env['EXECUTOR_VIEWER_TOKEN'] || undefined,
    allowedOrigins: (process.env['EXECUTOR_ALLOWED_ORIGINS'] ?? '').split(',').filter(Boolean),
    speraxosUrl: process.env['SPERAXOS_URL'] ?? 'https://api.speraxos.io',
    speraxosApiKey: process.env['SPERAXOS_API_KEY'] ?? '',
    maxAgents: parseInt(process.env['MAX_AGENTS'] ?? '5', 10),
    taskPollInterval: 1000,
    heartbeatInterval: 30_000,
    statePath: process.env['STATE_PATH'] ?? './data/executor.db',
};
const executor = new ExecutorServer(config);
process.on('SIGINT', async () => {
    console.log('Shutting down executor...');
    await executor.stop();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    await executor.stop();
    process.exit(0);
});
executor.start().then(() => {
    console.log(`Executor running on ws://localhost:${config.port}`);
}).catch(() => {
    console.error('Executor failed to start; check validated configuration and service health.');
    process.exit(1);
});
