"""Bound multipart requests before the upload parser can spool unlimited bytes."""

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


class UploadLimitMiddleware:
    def __init__(self, app, max_upload_bytes: int):
        self.app = app
        # Allow a bounded multipart envelope in addition to the file byte limit.
        self.limit = max_upload_bytes + 64 * 1024
        self.message = f"Upload request too large (file limit: {max_upload_bytes} bytes)."

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        for key, value in scope["headers"]:
            if key == b"content-length":
                try:
                    too_large = int(value) > self.limit
                except ValueError:
                    return await JSONResponse({"detail": "Invalid Content-Length."}, 400)(scope, receive, send)
                if too_large:
                    return await JSONResponse({"detail": self.message}, 413)(scope, receive, send)
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > self.limit:
                raise HTTPException(413, self.message)
            return message

        await self.app(scope, limited_receive, send)
