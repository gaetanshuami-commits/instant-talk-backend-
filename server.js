import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

io.on("connection", (socket) => {
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);

    socket.on("offer", (data) => {
      socket.to(roomId).emit("offer", { from: socket.id, offer: data });
    });

    socket.on("answer", (data) => {
      socket.to(roomId).emit("answer", { from: socket.id, answer: data });
    });

    socket.on("ice-candidate", (data) => {
      socket.to(roomId).emit("ice-candidate", { from: socket.id, candidate: data });
    });

    socket.on("disconnect", () => {
      socket.to(roomId).emit("user-left", socket.id);
    });
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
