export class RequestBodyError extends Error {
    status;
    constructor(status) {
        super('Invalid request body');
        this.status = status;
    }
}
export function readRequestBody(request, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        const cleanup = () => {
            request.off('data', onData);
            request.off('end', onEnd);
            request.off('error', onError);
            request.off('aborted', onError);
        };
        const onError = () => {
            cleanup();
            reject(new RequestBodyError(400));
        };
        const onData = (chunk) => {
            bytes += chunk.length;
            if (bytes > limit) {
                cleanup();
                request.pause();
                reject(new RequestBodyError(413));
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = () => {
            cleanup();
            try {
                const value = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    throw new Error();
                resolve(value);
            }
            catch {
                reject(new RequestBodyError(400));
            }
        };
        request.on('data', onData);
        request.once('end', onEnd);
        request.once('error', onError);
        request.once('aborted', onError);
    });
}
export function rejectRequestBody(request, response, error) {
    if (response.destroyed || response.headersSent) {
        request.destroy();
        return;
    }
    const status = error instanceof RequestBodyError ? error.status : 400;
    if (status === 413) {
        response.setHeader('Connection', 'close');
        response.once('finish', () => request.destroy());
    }
    response.writeHead(status).end(JSON.stringify({ error: status === 413 ? 'Request body too large' : 'Invalid request body' }));
}
