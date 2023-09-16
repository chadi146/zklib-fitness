import dgram from "dgram";
import { decode } from "./timestamp_parser";
import {
  createUDPHeader,
  decodeUserData28,
  decodeRecordData16,
  decodeRecordRealTimeLog18,
  decodeUDPHeader,
  exportErrorMessage,
  checkNotEventUDP,
} from "./utils";

import { MAX_CHUNK, REQUEST_DATA, COMMANDS } from "./constants";
import { log } from "./helpers/errorLog";

class ZKLibUDP {
  ip: string;
  port: number;
  timeout: number;
  sessionId: number | null;
  replyId: number;
  socket: dgram.Socket | null;
  inport: number;

  constructor(ip: string, port: number, timeout: number, inport: number) {
    this.ip = ip;
    this.port = port;
    this.timeout = timeout;
    this.socket = null;
    this.sessionId = null;
    this.replyId = 0;
    this.inport = inport;
  }

  createSocket(
    cbError?: (err: Error) => any,
    cbClose?: (type: string) => any
  ): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      // Create a new UDP socket
      this.socket = dgram.createSocket("udp4");
      this.socket.setMaxListeners(Infinity);

      // Error event listener
      this.socket.once("error", (err: Error) => {
        this.socket = null; // Cleanup the socket reference
        reject(err);
        if (cbError) cbError(err);
      });

      // Close event listener
      this.socket.on("close", () => {
        this.socket = null; // Cleanup the socket reference
        if (cbClose) cbClose("udp");
      });

      // Listening event listener
      this.socket.once("listening", () => resolve(this.socket!));

      // Attempt to bind the socket
      try {
        this.socket.bind(this.inport);
      } catch (err: any) {
        if (cbError) cbError(err); // Handle binding error
        reject(err); // Reject the promise as well
      }
    });
  }

  async connect(): Promise<boolean> {
    try {
      const reply = await this.executeCmd(COMMANDS.CMD_CONNECT, "");
      if (reply) {
        return true;
      } else {
        throw new Error("NO_REPLY_ON_CMD_CONNECT");
      }
    } catch (err: any) {
      throw err;
    }
  }

  async closeSocket(): Promise<boolean> {
    if (!this.socket) return true;

    return new Promise((resolve, _reject) => {
      this.socket?.removeAllListeners("message");

      const timer = setTimeout(() => {
        resolve(true);
      }, 2000);

      this.socket?.close(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async writeMessage(msg: Buffer, connect: boolean): Promise<Buffer> {
    if (!this.socket) {
      throw new Error("Socket is not initialized");
    }

    return new Promise((resolve, reject) => {
      let sendTimeoutId: NodeJS.Timeout;

      const onMessage = (data: Buffer) => {
        clearTimeout(sendTimeoutId);
        this.socket?.off("message", onMessage); // Remove the listener after it's triggered
        resolve(data);
      };

      this.socket?.once("message", onMessage);

      this.socket?.send(msg, 0, msg.length, this.port, this.ip, (err) => {
        if (err) {
          clearTimeout(sendTimeoutId); // Ensure timeout is cleared if an error occurs
          reject(err);
        } else if (this.timeout) {
          sendTimeoutId = setTimeout(
            () => {
              this.socket?.off("message", onMessage); // Ensure the listener is removed if a timeout occurs
              reject(new Error("TIMEOUT_ON_WRITING_MESSAGE"));
            },
            connect ? 2000 : this.timeout
          );
        }
      });
    });
  }

  async requestData(msg: string | Uint8Array): Promise<Buffer> {
    if (!this.socket) {
      throw new Error("Socket is not initialized");
    }

    return new Promise((resolve, reject) => {
      let sendTimeoutId: NodeJS.Timeout;

      const internalCallback = (data: Buffer) => {
        clearTimeout(sendTimeoutId);
        this.socket?.off("message", handleOnData);
        resolve(data);
      };

      const handleOnData = (data: Buffer) => {
        if (checkNotEventUDP(data)) return;

        clearTimeout(sendTimeoutId);
        if (data.length >= 13) {
          internalCallback(data);
        } else {
          // If data length is less than 13, set another timeout
          sendTimeoutId = setTimeout(() => {
            this.socket?.off("message", handleOnData);
            reject(new Error("TIMEOUT_ON_RECEIVING_REQUEST_DATA"));
          }, this.timeout);
        }
      };

      this.socket?.on("message", handleOnData);

      this.socket?.send(msg, 0, msg.length, this.port, this.ip, (err) => {
        if (err) {
          clearTimeout(sendTimeoutId); // Ensure timeout is cleared if an error occurs
          this.socket?.off("message", handleOnData); // Clean up the listener in case of an error
          reject(err);
        } else {
          sendTimeoutId = setTimeout(() => {
            this.socket?.off("message", handleOnData); // Ensure the listener is removed if a timeout occurs
            reject(
              new Error("TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA")
            );
          }, this.timeout);
        }
      });
    });
  }

  async executeCmd(command: number, data: any): Promise<any> {
    try {
      if (command === COMMANDS.CMD_CONNECT) {
        this.sessionId = 0;
        this.replyId = 0;
      } else {
        this.replyId++;
      }

      const buf = createUDPHeader(command, this.sessionId!, this.replyId, data);
      const reply = await this.writeMessage(
        buf,
        command === COMMANDS.CMD_CONNECT || command === COMMANDS.CMD_EXIT
      );

      if (reply && reply.length > 0 && command === COMMANDS.CMD_CONNECT) {
        this.sessionId = reply.readUInt16LE(4);
      }

      return reply;
    } catch (err) {
      throw err;
    }
  }

  sendChunkRequest(start: number, size: number): void {
    if (!this.socket) {
      log("[UDP][SEND_CHUNK_REQUEST] Socket is not initialized");
      return;
    }

    this.replyId++;

    const reqData = Buffer.alloc(8);
    reqData.writeUInt32LE(start, 0);
    reqData.writeUInt32LE(size, 4);

    const buf = createUDPHeader(
      COMMANDS.CMD_DATA_RDY,
      this.sessionId!,
      this.replyId,
      reqData
    );

    this.socket.send(buf, 0, buf.length, this.port, this.ip, (err) => {
      if (err) {
        log(`[UDP][SEND_CHUNK_REQUEST] ${err.toString()}`);
      }
    });
  }

  async readWithBuffer(
    reqData: any,
    cb?: (length: number, size: number) => void
  ): Promise<{ data: Buffer; err: Error | null }> {
    this.replyId++;
    const buf = createUDPHeader(
      COMMANDS.CMD_DATA_WRRQ,
      this.sessionId!,
      this.replyId,
      reqData
    );

    const reply = await this.requestData(buf);
    const header = decodeUDPHeader(reply.subarray(0, 8));

    switch (header.commandId) {
      case COMMANDS.CMD_DATA:
        return { data: reply.subarray(8), err: null };

      case COMMANDS.CMD_ACK_OK:
      case COMMANDS.CMD_PREPARE_DATA:
        return await this.handlePreparedData(reply, cb);

      default:
        throw new Error(
          "ERROR_IN_UNHANDLE_CMD " + exportErrorMessage(header.commandId)
        );
    }
  }

  async handlePreparedData(
    reply: Buffer,
    cb?: (length: number, size: number) => void
  ): Promise<{ data: Buffer; err: Error | null }> {
    const recvData = reply.subarray(8);
    const size = recvData.readUIntLE(1, 4);

    const numberChunks = Math.floor(size / MAX_CHUNK);
    const remain = size % MAX_CHUNK;

    let totalBuffer = Buffer.from([]);
    const timeout = 3000;

    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        resolve({
          data: totalBuffer,
          err: new Error("TIMEOUT WHEN RECEIVING PACKET"),
        });
      }, timeout);

      const handleOnData = (reply: Buffer) => {
        if (checkNotEventUDP(reply)) return;

        clearTimeout(timer);
        timer = setTimeout(() => {
          resolve({
            data: totalBuffer,
            err: new Error(
              `TIMEOUT!! ${(size - totalBuffer.length) / size} % REMAIN!`
            ),
          });
        }, timeout);

        const header = decodeUDPHeader(reply);

        switch (header.commandId) {
          case COMMANDS.CMD_DATA:
            totalBuffer = Buffer.concat([totalBuffer, reply.subarray(8)]);
            cb && cb(totalBuffer.length, size);
            break;

          case COMMANDS.CMD_ACK_OK:
            if (totalBuffer.length === size) {
              resolve({ data: totalBuffer, err: null });
            }
            break;

          case COMMANDS.CMD_PREPARE_DATA:
            // Seems to do nothing in the current implementation. Left for clarity.
            break;

          default:
            resolve({
              data: Buffer.from([]),
              err: new Error(
                "ERROR_IN_UNHANDLE_CMD " + exportErrorMessage(header.commandId)
              ),
            });
        }
      };

      this.socket?.on("message", handleOnData);

      for (let i = 0; i <= numberChunks; i++) {
        if (i === numberChunks) {
          this.sendChunkRequest(numberChunks * MAX_CHUNK, remain);
        } else {
          this.sendChunkRequest(i * MAX_CHUNK, MAX_CHUNK);
        }
      }
    });
  }

  async getUsers() {
    const executeFreeData = async () => {
      if (this.socket) {
        try {
          await this.freeData();
        } catch (err) {
          throw err;
        }
      }
    };

    try {
      await executeFreeData();

      const data = await this.readWithBuffer(REQUEST_DATA.GET_USERS);

      await executeFreeData();

      const USER_PACKET_SIZE = 28;
      let userData = data.data.subarray(4);
      const users = [];

      while (userData.length >= USER_PACKET_SIZE) {
        const user = decodeUserData28(userData.subarray(0, USER_PACKET_SIZE));
        users.push(user);
        userData = userData.subarray(USER_PACKET_SIZE);
      }

      return { data: users, err: data.err };
    } catch (err) {
      throw err;
    }
  }

  async getAttendances(callbackInProcess = () => {}) {
    const executeFreeData = async () => {
      if (this.socket) {
        await this.freeData();
      }
    };

    try {
      await executeFreeData();

      const data: any = await this.readWithBuffer(
        REQUEST_DATA.GET_ATTENDANCE_LOGS,
        callbackInProcess
      );

      await executeFreeData();

      // FIXME: fix data.mode data is of type Buffer
      const isSmallDataMode = data.mode;
      const RECORD_PACKET_SIZE = isSmallDataMode ? 8 : 16;

      let records = [];
      let recordData = data.data.subarray(4);

      while (recordData.length >= RECORD_PACKET_SIZE) {
        const record = decodeRecordData16(
          recordData.subarray(0, RECORD_PACKET_SIZE)
        );
        records.push({ ...record, ip: this.ip });
        recordData = recordData.subarray(RECORD_PACKET_SIZE);
      }

      return { data: records, err: data.err };
    } catch (err) {
      throw err;
    }
  }

  async freeData() {
    return await this.executeCmd(COMMANDS.CMD_FREE_DATA, "");
  }

  async getInfo(): Promise<{
    userCounts: any;
    logCounts: any;
    logCapacity: any;
  }> {
    try {
      const data = await this.executeCmd(COMMANDS.CMD_GET_FREE_SIZES, "");
      return {
        userCounts: data.readUIntLE(24, 4),
        logCounts: data.readUIntLE(40, 4),
        logCapacity: data.readUIntLE(72, 4),
      };
    } catch (err) {
      return await Promise.reject(err);
    }
  }

  async getTime() {
    try {
      const t = await this.executeCmd(COMMANDS.CMD_GET_TIME, "");
      return decode(t.readUInt32LE(8));
    } catch (err) {
      return await Promise.reject(err);
    }
  }

  clearAttendanceLog() {
    return this.executeCmd(COMMANDS.CMD_CLEAR_ATTLOG, "");
  }

  disableDevice() {
    return this.executeCmd(
      COMMANDS.CMD_DISABLEDEVICE,
      REQUEST_DATA.DISABLE_DEVICE
    );
  }

  enableDevice() {
    return this.executeCmd(COMMANDS.CMD_ENABLEDEVICE, "");
  }

  async disconnect() {
    try {
      await this.executeCmd(COMMANDS.CMD_EXIT, "");
    } catch (err) {}
    return await this.closeSocket();
  }

  getSocketStatus(): string {
    if (!this.socket) {
      return "No socket instance";
    }

    try {
      const address = this.socket.address();
      return `Bound to port ${address.port}`;
    } catch (error) {
      // Error indicates socket isn't bound
      return "Unbound";
    }
  }

  getRealTimeLogs(cb = (val: { userId: number; attTime: Date }) => {}) {
    this.replyId++;
    const buf = createUDPHeader(
      COMMANDS.CMD_REG_EVENT,
      this.sessionId as any,
      this.replyId,
      REQUEST_DATA.GET_REAL_TIME_EVENT
    );

    this.socket?.send(buf, 0, buf.length, this.port, this.ip, (err) => {});

    if (this.socket?.listenerCount("message")! < 2) {
      this.socket?.on("message", (data) => {
        if (!checkNotEventUDP(data)) return;
        if (data.length === 18) {
          cb(decodeRecordRealTimeLog18(data));
        }
      });
    }
  }
}

export default ZKLibUDP;
