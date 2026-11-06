import type { ApiError } from "@pi-vue3/protocol";

export class HttpError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
		readonly details?: ApiError["error"]["details"],
	) {
		super(message);
		this.name = "HttpError";
	}
}

export function apiError(error: HttpError, traceId?: string): ApiError {
	return {
		error: {
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
			...(traceId === undefined ? {} : { traceId }),
		},
	};
}
