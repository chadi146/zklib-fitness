import net from "net";
import { MAX_CHUNK, COMMANDS, REQUEST_DATA } from "./constants";
import { decode } from "./timestamp_parser";
import {
  createTCPHeader,
  exportErrorMessage,
  removeTcpHeader,
  decodeUserData72,
  decodeRecordData40,
  decodeRecordRealTimeLog52,
  checkNotEventTCP,
  decodeTCPHeader,
} from "./utils";
import { log } from "./helpers/errorLog";
import { Result } from "./helpers/types";

const MAX_UID = 3000;
const MAX_USERID_LENGTH = 9;
const MAX_NAME_LENGTH = 24;
const MAX_PASSWORD_LENGTH = 8;
const MAX_CARDNO_LENGTH = 10;
const MAX_ALLOWED_REPLY_ID = 100;

class ZKLibTCP {
  ip: string | number;
  port: number;
  timeout: number;
  sessionId: number | null;
  replyId: number;
  socket: net.Socket | null;
  private socketStatus: string = "Closed";

  constructor(ip: string | number, port: number, timeout: number) {
    this.ip = ip;
    this.port = port;
    this.timeout = timeout;
    this.sessionId = null;
    this.replyId = 0;
    this.socket = null;
  }

  createSocket(
    cbError: (error: Error) => void,
    cbClose: (type: string) => void
  ): Promise<net.Socket | null> {
    return new Promise<net.Socket | null>((resolve, reject) => {
      this.socket = new net.Socket();

      this.socket.once("error", (err: Error) => {
        this.socketStatus = "Error";
        reject(err);
        if (cbError) cbError(err);
      });

      this.socket.once("connect", () => {
        this.socketStatus = "Open";
        resolve(this.socket);
      });

      this.socket.once("close", () => {
        this.socket = null;
        this.socketStatus = "Closed";
        if (cbClose) cbClose("tcp");
      });

      if (this.timeout) {
        this.socket.setTimeout(this.timeout);
      }

      this.socket.connect(this.port.toString(), () => this.ip);
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
    } catch (err) {
      throw err;
    }
  }

  async closeSocket(): Promise<boolean> {
    return new Promise((resolve) => {
      this.socket?.removeAllListeners("data");

      // Using a shared resolution function to handle both timeout and socket end.
      const resolveSocketClosure = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.socket?.end(resolveSocketClosure);

      /**
       * When socket isn't connected so this.socket.end will never resolve
       * we use settimeout for handling this case
       */
      const timer = setTimeout(resolveSocketClosure, 2000);
    });
  }

  async writeMessage(msg: Buffer, connect: boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      this.socket?.once("data", (data) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(data);
      });

      this.socket?.write(msg, (err) => {
        if (err) {
          reject(err);
        } else if (this.timeout) {
          timer = setTimeout(
            () => {
              if (timer) {
                clearTimeout(timer);
              }
              reject(new Error("TIMEOUT_ON_WRITING_MESSAGE"));
            },
            connect ? 2000 : this.timeout
          );
        }
      });
    });
  }

  async requestData(msg: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      let replyBuffer = Buffer.from([]);

      const internalCallback = (data: Buffer) => {
        this.socket?.removeListener("data", handleOnData);
        if (timer) {
          clearTimeout(timer);
        }
        resolve(data);
      };

      const handleOnData = (data: Buffer) => {
        replyBuffer = Buffer.concat([replyBuffer, data]);
        if (checkNotEventTCP(data)) return;

        if (timer) {
          clearTimeout(timer);
        }

        const header = decodeTCPHeader(replyBuffer.subarray(0, 16));

        if (header.commandId === COMMANDS.CMD_DATA) {
          timer = setTimeout(() => {
            internalCallback(replyBuffer);
          }, 1000);
        } else {
          timer = setTimeout(() => {
            reject(new Error("TIMEOUT_ON_RECEIVING_REQUEST_DATA"));
          }, this.timeout);

          const packetLength = data.readUIntLE(4, 2);
          if (packetLength > 8) {
            internalCallback(data);
          }
        }
      };

      this.socket?.on("data", handleOnData);

      this.socket?.write(msg, (err) => {
        if (err) {
          reject(err);
        }

        timer = setTimeout(() => {
          reject(
            new Error("TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA")
          );
        }, this.timeout);
      });
    }).catch((err) => {
      console.log("Promise Rejected:", err);
      throw err; // Re-throw to allow downstream handling
    });
  }

  executeCmd(command: number, data: string | Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (command === COMMANDS.CMD_CONNECT) {
        this.sessionId = 0;
        this.replyId = 0;
      } else {
        this.replyId++;
      }

      const buf = createTCPHeader(
        command,
        this.sessionId!,
        this.replyId,
        typeof data === "string" ? Buffer.from(data) : data
      );

      this.writeMessage(
        buf,
        command === COMMANDS.CMD_CONNECT || command === COMMANDS.CMD_EXIT
      )
        .then((reply) => {
          const rReply = removeTcpHeader(reply);
          if (rReply && rReply.length) {
            if (command === COMMANDS.CMD_CONNECT) {
              this.sessionId = rReply.readUInt16LE(4);
            }
          }
          resolve(rReply);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  sendChunkRequest(start: number, size: number): void {
    this.replyId++;

    const reqData = Buffer.alloc(8);
    reqData.writeUInt32LE(start, 0);
    reqData.writeUInt32LE(size, 4);

    const buf = createTCPHeader(
      COMMANDS.CMD_DATA_RDY,
      this.sessionId!,
      this.replyId,
      reqData
    );

    this.socket?.write(buf, (err) => {
      if (err) {
        log(`[TCP][SEND_CHUNK_REQUEST] ${err.toString()}`);
      }
    });
  }

  readWithBuffer(
    reqData: Buffer,
    cb: ((length: number, size: number) => void) | null = null
  ): Promise<{
    data: Buffer;
    err?: Error;
    mode?: number;
  }> {
    return new Promise(async (resolve, reject) => {
      this.replyId++;

      const buf = createTCPHeader(
        COMMANDS.CMD_DATA_WRRQ,
        this.sessionId!,
        this.replyId,
        reqData
      );

      let reply: Buffer;

      try {
        reply = await this.requestData(buf);
        console.log(reply.toString("hex"));
      } catch (err) {
        // console.log(reply);
        return reject(err);
      }

      const header = decodeTCPHeader(reply.subarray(0, 16));
      switch (header.commandId) {
        case COMMANDS.CMD_DATA: {
          resolve({ data: reply.subarray(16), mode: 8 });
          break;
        }
        case COMMANDS.CMD_ACK_OK:
        case COMMANDS.CMD_PREPARE_DATA: {
          // this case show that data is prepared => send command to get these data
          // reply variable includes information about the size of following data
          const recvData = reply.subarray(16);
          const size = recvData.readUIntLE(1, 4);

          // We need to split the data to many chunks to receive , because it's to large
          // After receiving all chunk data , we concat it to TotalBuffer variable , that 's the data we want
          let remain = size % MAX_CHUNK;
          let numberChunks = Math.round(size - remain) / MAX_CHUNK;
          let totalPackets = numberChunks + (remain > 0 ? 1 : 0);
          let replyData = Buffer.from([]);

          let totalBuffer = Buffer.from([]);
          let realTotalBuffer = Buffer.from([]);

          const timeout = 10000;
          let timer = setTimeout(() => {
            internalCallback(
              replyData,
              new Error("TIMEOUT WHEN RECEIVING PACKET")
            );
          }, timeout);

          const internalCallback = (
            replyData: Buffer,
            err: Error | undefined = undefined
          ) => {
            // this.socket && this.socket.removeListener('data', handleOnData)
            timer && clearTimeout(timer);
            resolve({ data: replyData, err });
          };

          const handleOnData = (reply: any) => {
            if (checkNotEventTCP(reply)) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
              internalCallback(
                replyData,
                new Error(`TIME OUT !! ${totalPackets} PACKETS REMAIN !`)
              );
            }, timeout);

            totalBuffer = Buffer.concat([totalBuffer, reply]);
            const packetLength = totalBuffer.readUIntLE(4, 2);
            if (totalBuffer.length >= 8 + packetLength) {
              realTotalBuffer = Buffer.concat([
                realTotalBuffer,
                totalBuffer.subarray(16, 8 + packetLength),
              ]);
              totalBuffer = totalBuffer.subarray(8 + packetLength);

              if (
                (totalPackets > 1 &&
                  realTotalBuffer.length === MAX_CHUNK + 8) ||
                (totalPackets === 1 && realTotalBuffer.length === remain + 8)
              ) {
                replyData = Buffer.concat([
                  replyData,
                  realTotalBuffer.subarray(8),
                ]);
                totalBuffer = Buffer.from([]);
                realTotalBuffer = Buffer.from([]);

                totalPackets -= 1;
                cb && cb(replyData.length, size);

                if (totalPackets <= 0) {
                  internalCallback(replyData);
                }
              }
            }
          };

          this.socket?.once("close", () => {
            internalCallback(
              replyData,
              new Error("Socket is disconnected unexpectedly")
            );
          });

          this.socket?.on("data", handleOnData);

          for (let i = 0; i <= numberChunks; i++) {
            if (i === numberChunks) {
              this.sendChunkRequest(numberChunks * MAX_CHUNK, remain);
            } else {
              this.sendChunkRequest(i * MAX_CHUNK, MAX_CHUNK);
            }
          }

          break;
        }

        default:
          reject(
            new Error(
              "ERROR_IN_UNHANDLE_CMD " + exportErrorMessage(header.commandId)
            )
          );
      }
    });
  }

  getSocketStatus(): string {
    if (!this.socket) {
      return "No socket instance";
    }

    if (this.socket.destroyed) {
      return "Closed";
    }

    return this.socketStatus;
  }

  private async handleBufferFreeing(): Promise<void> {
    if (this.socket) {
      await this.freeData();
    }
  }

  public async getUsers(): Promise<Result<any[]>> {
    try {
      await this.handleBufferFreeing();

      const data = await this.readWithBuffer(REQUEST_DATA.GET_USERS);
      await this.handleBufferFreeing();

      const USER_PACKET_SIZE = 72;
      let userData = data.data.subarray(4);
      let users: any[] = [];

      while (userData.length >= USER_PACKET_SIZE) {
        const user = decodeUserData72(userData.subarray(0, USER_PACKET_SIZE));
        users.push(user);
        userData = userData.subarray(USER_PACKET_SIZE);
      }

      return { data: users };
    } catch (err) {
      throw err;
    }
  }

  public async getAttendances(
    callbackInProcess = () => {}
  ): Promise<Result<any[]>> {
    try {
      await this.handleBufferFreeing();

      const data = await this.readWithBuffer(
        REQUEST_DATA.GET_ATTENDANCE_LOGS,
        callbackInProcess
      );
      await this.handleBufferFreeing();

      const RECORD_PACKET_SIZE = 40;
      let recordData = data.data.subarray(4);
      let records: any[] = [];

      while (recordData.length >= RECORD_PACKET_SIZE) {
        const record = decodeRecordData40(
          recordData.subarray(0, RECORD_PACKET_SIZE)
        );
        records.push({ ...record, ip: this.ip });
        recordData = recordData.subarray(RECORD_PACKET_SIZE);
      }

      return { data: records };
    } catch (err) {
      throw err;
    }
  }

  public async freeData(): Promise<void> {
    await this.executeCmd(COMMANDS.CMD_FREE_DATA, "");
  }

  async disableDevice(): Promise<Buffer> {
    return await this.executeCmd(
      COMMANDS.CMD_DISABLEDEVICE,
      REQUEST_DATA.DISABLE_DEVICE
    );
  }

  async enableDevice(): Promise<Buffer> {
    return await this.executeCmd(COMMANDS.CMD_ENABLEDEVICE, "");
  }

  async disconnect(): Promise<boolean> {
    try {
      await this.executeCmd(COMMANDS.CMD_EXIT, "");
    } catch (err) {}
    return await this.closeSocket();
  }

  async getInfo(): Promise<{
    userCounts: any;
    logCounts: any;
    logCapacity: any;
  }> {
    try {
      const data: any = await this.executeCmd(COMMANDS.CMD_GET_FREE_SIZES, "");

      return {
        userCounts: data?.readUIntLE(24, 4),
        logCounts: data?.readUIntLE(40, 4),
        logCapacity: data?.readUIntLE(72, 4),
      };
    } catch (err) {
      return Promise.reject(err);
    }
  }

  private async getDeviceOption(
    keyword: string,
    asciiConversion = true
  ): Promise<string> {
    try {
      const data: any = await this.executeCmd(
        COMMANDS.CMD_OPTIONS_RRQ,
        keyword
      );
      const result = data
        .slice(8)
        .toString(asciiConversion ? "ascii" : "utf-8")
        .replace(keyword + "=", "");

      return result;
    } catch (err) {
      throw err;
    }
  }

  public async getSerialNumber(): Promise<string> {
    return this.getDeviceOption("~SerialNumber", false);
  }

  public async getDeviceVersion(): Promise<string> {
    return this.getDeviceOption("~ZKFPVersion");
  }

  public async getDeviceName(): Promise<string> {
    return this.getDeviceOption("~DeviceName");
  }

  async getPlatform(): Promise<string> {
    return this.getDeviceOption("~Platform");
  }

  async getOS(): Promise<string> {
    return this.getDeviceOption("~OS");
  }

  async getWorkCode(): Promise<string> {
    return this.getDeviceOption("WorkCode");
  }

  async getPIN(): Promise<string> {
    return this.getDeviceOption("~PIN2Width");
  }
  public async getFaceOn(): Promise<string> {
    const result = await this.getDeviceOption("FaceFunOn");
    return result.includes("0") ? "No" : "Yes";
  }

  async getSSR(): Promise<string> {
    return this.getDeviceOption("~SSR");
  }

  async getFirmware(): Promise<any> {
    try {
      const data: any = await this.executeCmd(1100, "");
      return data.slice(8).toString("ascii");
    } catch (err: any) {
      return Promise.reject("Failed to get firmware: " + err.message);
    }
  }

  async getTime(): Promise<Date> {
    try {
      const t: any = await this.executeCmd(COMMANDS.CMD_GET_TIME, "");
      return decode(t.readUInt32LE(8));
    } catch (err: any) {
      return Promise.reject("Failed to get time: " + err.message);
    }
  }

  async setUser(
    uid: string,
    userid: string,
    name: string,
    password: string,
    role = 0,
    cardno = "0"
  ): Promise<Buffer> {
    try {
      if (
        parseInt(uid) === 0 ||
        parseInt(uid) > MAX_UID ||
        userid.length > MAX_USERID_LENGTH ||
        name.length > MAX_NAME_LENGTH ||
        password.length > MAX_PASSWORD_LENGTH ||
        cardno.length > MAX_CARDNO_LENGTH
      ) {
        throw new Error("Invalid input parameters");
      }

      const command_string = Buffer.alloc(72);
      command_string.writeUInt16LE(parseInt(uid), 0);
      command_string.writeUInt16LE(role, 2);
      command_string.write(password, 3, 8);
      command_string.write(name, 11, 24);
      command_string.writeUInt16LE(parseInt(cardno), 35);
      command_string.writeUInt32LE(0, 40);
      command_string.write(userid ? Number(userid).toString(9) : "", 48);

      return await this.executeCmd(COMMANDS.CMD_USER_WRQ, command_string);
    } catch (err: any) {
      return Promise.reject("Failed to set user: " + err.message);
    }
  }

  async getAttendanceSize(): Promise<any> {
    try {
      const data: any = await this.executeCmd(COMMANDS.CMD_GET_FREE_SIZES, "");
      return data.readUIntLE(40, 4);
    } catch (err: any) {
      return Promise.reject("Failed to get attendance size: " + err.message);
    }
  }

  async clearAttendanceLog(): Promise<Buffer> {
    try {
      return await this.executeCmd(COMMANDS.CMD_CLEAR_ATTLOG, "");
    } catch (err: any) {
      return Promise.reject("Failed to clear attendance log: " + err.message);
    }
  }

  async getRealTimeLogs(
    cb: (data: any) => void = () => {}
  ): Promise<undefined> {
    this.replyId++;

    if (this.replyId > MAX_ALLOWED_REPLY_ID) {
      // Reset or handle accordingly
      this.replyId = 0; // or some appropriate value
    }

    try {
      const buf = createTCPHeader(
        COMMANDS.CMD_REG_EVENT,
        this.sessionId!,
        this.replyId,
        Buffer.from([0x01, 0x00, 0x00, 0x00])
      );

      this.socket!.write(buf, (err) => {
        if (err) {
          throw err;
        }
      });

      this.socket!.listenerCount("data") === 0 &&
        this.socket!.on("data", (data) => {
          if (!checkNotEventTCP(data)) return;
          if (data.length > 16) {
            cb(decodeRecordRealTimeLog52(data));
          }
        });
    } catch (err: any) {
      return Promise.reject("Failed to get real-time logs: " + err.message);
    }
  }
}

export default ZKLibTCP;
