// Define the error types using an enum for better type safety
enum ERROR_TYPES {
    ECONNRESET = 'ECONNRESET',
    ECONNREFUSED = 'ECONNREFUSED',
    EADDRINUSE = 'EADDRINUSE',
    ETIMEDOUT = 'ETIMEDOUT',
    EINVALID = 'EINVALID'
}

// Define an interface for the error object
interface IError {
    message: string;
    code: keyof typeof ERROR_TYPES;
}

class ZKError {
    private err: IError;
    private ip: string;
    private command: string;

    constructor(err: IError, command: string, ip: string) {
        this.err = err;
        this.ip = ip;
        this.command = command;
    }

    toast(): string {
        switch (this.err.code) {
            case ERROR_TYPES.ECONNRESET:
                return 'Another device is connecting to the device so the connection is interrupted';
            case ERROR_TYPES.ECONNREFUSED:
                return 'IP of the device is refused';
            default:
                return this.err.message;
        }
    }

    getError(): { err: IError; ip: string; command: string } {
        return {
            err: {
                message: this.err.message,
                code: this.err.code
            },
            ip: this.ip,
            command: this.command
        };
    }
}

export { ZKError, ERROR_TYPES };
