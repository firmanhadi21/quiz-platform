"""Stand-in for the Hermes API on a Unix socket, for the browser test.

    python tests/fake_hermes.py /tmp/fake-hermes.sock      (expects the key "test-key")
"""
import json
import os
import socketserver
import sys
from http.server import BaseHTTPRequestHandler

QUESTIONS = {"title": "Proyeksi UTM", "questions": [
    {"type": "single", "text": "Berapa lebar satu zona UTM?", "options": ["3 derajat", "6 derajat", "10 derajat", "12 derajat"],
     "answer": 1, "explanation": "Bumi dibagi menjadi 60 zona selebar 6 derajat bujur."},
    {"type": "tf", "text": "UTM memakai proyeksi Transverse Mercator.", "answer": True, "explanation": "Setiap zona memakai Transverse Mercator."},
    {"type": "single", "text": "Faktor skala di meridian tengah UTM?", "options": ["1,0000", "0,9996", "0,9999", "0,9990"],
     "answer": 1, "explanation": "Faktor skala UTM adalah 0,9996."}]}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ok = self.headers.get("Authorization") == "Bearer test-key" and body["messages"][1]["content"].startswith(("<material>", "<passage>"))
        quiz = QUESTIONS
        if "<rubric>" in body["messages"][1]["content"]:  # a rubric was sent: label each question
            names = ["Sistem zona UTM", "Jenis proyeksi", "Faktor skala"]
            quiz = {**QUESTIONS, "questions": [{**q, "criterion": names[i]} for i, q in enumerate(QUESTIONS["questions"])]}
        reply = json.dumps({"choices": [{"message": {"role": "assistant", "content": json.dumps(quiz, ensure_ascii=False)}}]}).encode()
        self.send_response(200 if ok else 401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def address_string(self):
        return "socket"

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingUnixStreamServer):
    def get_request(self):
        request, _ = super().get_request()
        return request, ("socket", 0)


if __name__ == "__main__":
    path = sys.argv[1]
    if os.path.exists(path):
        os.unlink(path)
    Server(path, Handler).serve_forever()
