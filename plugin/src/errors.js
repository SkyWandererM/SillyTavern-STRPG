export class AppError extends Error {
    /**
     * @param {string} message
     * @param {object} [options]
     * @param {number} [options.status]
     * @param {string} [options.code]
     * @param {any} [options.details]
     * @param {Error} [options.cause]
     */
    constructor(message, options = {}) {
        super(message, { cause: options.cause });
        this.name = 'AppError';
        this.status = options.status ?? 500;
        this.code = options.code ?? 'STRPG_ERROR';
        this.details = options.details;
    }
}

export class ValidationError extends AppError {
    constructor(message, details) {
        super(message, { status: 422, code: 'VALIDATION_FAILED', details });
        this.name = 'ValidationError';
    }
}

export class NotFoundError extends AppError {
    constructor(message, code = 'NOT_FOUND') {
        super(message, { status: 404, code });
        this.name = 'NotFoundError';
    }
}

export class ConflictError extends AppError {
    constructor(message, code = 'CONFLICT', details) {
        super(message, { status: 409, code, details });
        this.name = 'ConflictError';
    }
}

export class PermissionError extends AppError {
    constructor(message = 'Studio access denied') {
        super(message, { status: 403, code: 'FORBIDDEN' });
        this.name = 'PermissionError';
    }
}
