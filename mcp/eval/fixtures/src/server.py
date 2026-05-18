def handle_request(req):
    return {"status": "ok", "data": req.get("payload")}

class RequestHandler:
    def handle(self, req): return handle_request(req)
