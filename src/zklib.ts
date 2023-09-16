import ZKLibTCP from "./zklibtcp";
import ZKLibUDP from "./zklibudp";
import { ZKError, ERROR_TYPES } from "./zkerror";

class ZKLib {
  zklibTcp: ZKLibTCP;
  zklibUdp: ZKLibUDP;
  connectionType: "tcp" | "udp" | null;
  timer: number | null;
  interval: number | null;
  isBusy: boolean;
  ip: string;

  constructor(ip: string, port: number, timeout: number, inport: number) {
    this.connectionType = null;

    this.zklibTcp = new ZKLibTCP(ip, port, timeout);
    this.zklibUdp = new ZKLibUDP(ip, port, timeout, inport);
    this.interval = null;
    this.timer = null;
    this.isBusy = false;
    this.ip = ip;
  }

  async functionWrapper(
    tcpCallback: () => any,
    udpCallback?: () => any,
    command?: string | number
  ) {
    let connectionTypeMsg = "";
    let callback: () => any;

    switch (this.connectionType) {
      case "tcp":
        connectionTypeMsg = "[TCP]";
        if (!this.zklibTcp.socket) {
          throw this.createConnectionError(connectionTypeMsg);
        }
        callback = tcpCallback;
        break;
      case "udp":
        connectionTypeMsg = "[UDP]";
        if (!this.zklibUdp.socket) {
          throw this.createConnectionError(connectionTypeMsg);
        }
        if (!udpCallback) {
          throw new ZKError(
            {
              code: ERROR_TYPES.EINVALID,
              message: `UDP callback not provided`,
            },
            connectionTypeMsg,
            this.ip
          );
        }
        callback = udpCallback;
        break;
      default:
        throw this.createConnectionError("");
    }

    try {
      return await callback();
    } catch (err: any) {
      throw new ZKError(err, `${connectionTypeMsg} ${command}`, this.ip);
    }
  }

  private createConnectionError(connectionTypeMsg: string) {
    return new ZKError(
      {
        code: ERROR_TYPES.ECONNREFUSED,
        message: `Socket isn't connected !`,
      },
      connectionTypeMsg,
      this.ip
    );
  }

  async createSocket(cbErr?: any, cbClose?: any) {
    try {
      await this.tryTcpConnection(cbErr, cbClose);
    } catch (err: any) {
      if (err.code !== ERROR_TYPES.ECONNREFUSED) {
        throw new ZKError(err, "TCP CONNECT", this.ip);
      }

      try {
        await this.tryUdpConnection(cbErr, cbClose);
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          await this.cleanupSockets();
          throw new ZKError(err, "UDP CONNECT", this.ip);
        } else {
          this.connectionType = "udp";
        }
      }
    }
  }

  private async tryTcpConnection(cbErr?: any, cbClose?: any) {
    if (!this.zklibTcp.socket) {
      await this.zklibTcp.createSocket(cbErr, cbClose);
      await this.zklibTcp.connect();
      console.log("ok tcp");
      this.connectionType = "tcp";
    }
  }

  private async tryUdpConnection(cbErr?: any, cbClose?: any) {
    if (!this.zklibUdp.socket) {
      await this.zklibUdp.createSocket(cbErr, cbClose);
      await this.zklibUdp.connect();
      console.log("ok udp");
      this.connectionType = "udp";
    }
  }

  private async cleanupSockets() {
    this.connectionType = null;
    try {
      await this.zklibUdp.disconnect();
      this.zklibUdp.socket = null;
      this.zklibTcp.socket = null;
    } catch (err) {}
  }

  async getUsers() {
    return await this.functionWrapper(
      () => this.zklibTcp.getUsers(),
      () => this.zklibUdp.getUsers()
    );
  }

  async getTime() {
    return await this.functionWrapper(
      () => this.zklibTcp.getTime(),
      () => this.zklibUdp.getTime()
    );
  }
  async getSerialNumber() {
    return await this.functionWrapper(() => this.zklibTcp.getSerialNumber());
  }

  async getDeviceVersion() {
    return await this.functionWrapper(() => this.zklibTcp.getDeviceVersion());
  }
  async getDeviceName() {
    return await this.functionWrapper(() => this.zklibTcp.getDeviceName());
  }
  async getPlatform() {
    return await this.functionWrapper(() => this.zklibTcp.getPlatform());
  }
  async getOS() {
    return await this.functionWrapper(() => this.zklibTcp.getOS());
  }
  async getWorkCode() {
    return await this.functionWrapper(() => this.zklibTcp.getWorkCode());
  }
  async getPIN() {
    return await this.functionWrapper(() => this.zklibTcp.getPIN());
  }
  async getFaceOn() {
    return await this.functionWrapper(() => this.zklibTcp.getFaceOn());
  }
  async getSSR() {
    return await this.functionWrapper(() => this.zklibTcp.getSSR());
  }
  async getFirmware() {
    return await this.functionWrapper(() => this.zklibTcp.getFirmware());
  }
  async setUser(
    uid: string,
    userid: string,
    name: string,
    password: string,
    role = 0,
    cardno = "0"
  ) {
    return await this.functionWrapper(() =>
      this.zklibTcp.setUser(uid, userid, name, password, role, cardno)
    );
  }

  async getAttendanceSize() {
    return await this.functionWrapper(() => this.zklibTcp.getAttendanceSize());
  }

  async getAttendances(cb?: (...params: any) => any) {
    return await this.functionWrapper(
      () => this.zklibTcp.getAttendances(cb),
      () => this.zklibUdp.getAttendances(cb)
    );
  }

  async getRealTimeLogs(cb?: (data: any) => any) {
    return await this.functionWrapper(
      () => this.zklibTcp.getRealTimeLogs(cb),
      () => this.zklibUdp.getRealTimeLogs(cb)
    );
  }

  async disconnect() {
    return await this.functionWrapper(
      () => this.zklibTcp.disconnect(),
      () => this.zklibUdp.disconnect()
    );
  }

  async freeData() {
    return await this.functionWrapper(
      () => this.zklibTcp.freeData(),
      () => this.zklibUdp.freeData()
    );
  }

  async disableDevice() {
    return await this.functionWrapper(
      () => this.zklibTcp.disableDevice(),
      () => this.zklibUdp.disableDevice()
    );
  }

  async enableDevice() {
    return await this.functionWrapper(
      () => this.zklibTcp.enableDevice(),
      () => this.zklibUdp.enableDevice()
    );
  }

  async getInfo() {
    return await this.functionWrapper(
      () => this.zklibTcp.getInfo(),
      () => this.zklibUdp.getInfo()
    );
  }

  async getSocketStatus() {
    return await this.functionWrapper(
      () => this.zklibTcp.getSocketStatus(),
      () => this.zklibUdp.getSocketStatus()
    );
  }

  async clearAttendanceLog() {
    return await this.functionWrapper(
      () => this.zklibTcp.clearAttendanceLog(),
      () => this.zklibUdp.clearAttendanceLog()
    );
  }

  async executeCmd(command: number, data = "") {
    return await this.functionWrapper(
      () => this.zklibTcp.executeCmd(command, data),
      () => this.zklibUdp.executeCmd(command, data)
    );
  }

  setIntervalSchedule(cb: () => any, timer: number) {
    this.interval = setInterval(cb, timer) as any;
  }

  setTimerSchedule(cb: () => any, timer: number) {
    this.timer = setTimeout(cb, timer) as any;
  }
}

export default ZKLib;
