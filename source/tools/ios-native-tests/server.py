from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import json, base64

frame = '<g><path/><path d="M0000000010 20 30 40 50 60 70 80 90 100 110' + 'C10 20 30 40 50 60 70 80 90 100 110' * 15 + '"/></g>'
engine_home = '<html><head><meta name="twitter-site-verification" content="' + base64.b64encode(bytes(32)).decode() + '"><script src="https://abs.twimg.com/responsive-web/client-web/ondemand.s.fixturehasha.js"></script><script>globalThis.pageScriptRan=true</script></head><body>' + ''.join('<svg id="loading-x-anim-'+str(i)+'">'+frame+'</svg>' for i in range(4)) + '</body></html>'
native_reads = {}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith('/i/api/1.1/account/'):
            token = self.headers.get('Cookie','')
            native_reads[token] = native_reads.get(token,0) + 1
            status = 200; content = b'{"users":[{"user_id":"42","screen_name":"fixture"}]}'
            verify = 'verify_credentials' in parsed.path
            if 'fixture-fallback' in token:
                status = 200 if verify else 404
                content = b'{"id_str":"42","screen_name":"fixture"}' if verify else b'{}'
            elif 'fixture-denied' in token: status = 401; content = b'{"errors":[{"code":89}]}'
            elif 'fixture-limited' in token: status = 429; content = b'{}'
            elif 'fixture-challenge' in token: status = 403; content = b'{"errors":[{"code":326}]}'
            elif 'fixture-transient' in token and native_reads[token] == 1: status = 503; content = b'{}'
            elif 'fixture-redirect' in token:
                self.send_response(302); self.send_header('Location','/must-not-receive-credentials'); self.end_headers(); return
            elif 'fixture-large' in token: content = b'x' * 600000
            elif 'fixture-invalid' in token: content = b'<html>auth_token=never-include-me</html>'
            csrf = self.headers.get('x-csrf-token','')
            if csrf not in ['fixture-csrf','fixture-rotated'] or 'ct0='+csrf not in token: status = 401
            self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(content)))
            self.send_header('Set-Cookie','ct0=fixture-rotated; Path=/; HttpOnly')
            self.end_headers(); self.wfile.write(content); return
        paths = {
            '/': ('text/html', b'<html><head><link rel="stylesheet" href="/page.css"><script src="/page.js"></script></head><body><img id="image" src="/pixel.svg"></body></html>'),
            '/page.js': ('application/javascript', b'globalThis.pageScriptRan=true;'),
            '/page.css': ('text/css', b'body { color:rgb(1,2,3); }'),
            '/pixel.svg': ('image/svg+xml', b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
            '/explicit-fetch': ('text/plain', b'explicit-fetch-ok'),
            '/engine-home': ('text/html', engine_home.encode()),
            '/engine-demand': ('text/plain', b'(keyBytes[0],16)(keyBytes[1],16)'),
            '/engine-me': ('application/json', b'{"users":[{"user_id":"42","screen_name":"fixture"}]}'),
            '/engine-profile': ('application/json', b'{"data":{"user":{"result":{"rest_id":"42","core":{"screen_name":"fixture","name":"Fixture"},"legacy":{"following":true}}}}}'),
        }
        status = 200
        if parsed.path in ['/engine-me', '/engine-profile']:
            valid = 'auth_token=fixture-only' in self.headers.get('Cookie','') and self.headers.get('x-csrf-token') == 'fixture-csrf' and 'ct0=fixture-csrf' in self.headers.get('Cookie','')
            if parsed.path == '/engine-profile':
                features = json.loads(parse_qs(parsed.query).get('features',['{}'])[0])
                valid = valid and features.get('subscriptions_verification_info_verified_since_enabled') is True and len(self.headers.get('x-client-transaction-id','')) > 20
            if not valid: status = 401
        content_type, content = paths.get(parsed.path, ('text/plain', b''))
        if status != 200: content = b'{"errors":[{"code":89}]}'
        self.send_response(status); self.send_header('Content-Type',content_type); self.send_header('Content-Length',str(len(content))); self.end_headers(); self.wfile.write(content)
HTTPServer(('127.0.0.1',8769),Handler).serve_forever()
