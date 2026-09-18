from fastapi import Request
from fastapi.responses import JSONResponse

from switch_core.sessions.service import SessionError


async def session_error_response(request: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, SessionError):
        raise error
    status = {
        "NOT_AUTHORIZED": 403,
        "NOT_FOUND": 404,
        "INVALID_ANSWER": 422,
        "INVALID_ATTACHMENT": 422,
        "UNSUPPORTED_MODEL": 422,
        "UNSUPPORTED_CAPABILITY": 422,
        "INVALID_EVENT": 422,
        "PAYLOAD_TOO_LARGE": 413,
    }.get(error.code, 409)
    return JSONResponse(
        status_code=status, content={"code": error.code, "message": str(error)}
    )
