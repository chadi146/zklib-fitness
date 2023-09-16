import { USHRT_MAX, COMMANDS } from "./constants";
import { log } from "./helpers/errorLog";

const parseTimeToDate = (time: number): Date => {
  const second = time % 60;
  time = (time - second) / 60;
  const minute = time % 60;
  time = (time - minute) / 60;
  const hour = time % 24;
  time = (time - hour) / 24;
  const day = (time % 31) + 1;
  time = (time - (day - 1)) / 31;
  const month = time % 12;
  time = (time - month) / 12;
  const year = time + 2000;

  return new Date(year, month, day, hour, minute, second);
};

const parseHexToTime = (hex: Buffer): Date => {
  const time = {
    year: hex.readUIntLE(0, 1),
    month: hex.readUIntLE(1, 1),
    date: hex.readUIntLE(2, 1),
    hour: hex.readUIntLE(3, 1),
    minute: hex.readUIntLE(4, 1),
    second: hex.readUIntLE(5, 1),
  };

  return new Date(
    2000 + time.year,
    time.month - 1,
    time.date,
    time.hour,
    time.minute,
    time.second
  );
};

const createCheckSum = (buf: Buffer): number => {
  let checkSum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (i == buf.length - 1) {
      checkSum += buf[i];
    } else {
      checkSum += buf.readUInt16LE(i);
    }
    checkSum %= USHRT_MAX;
  }
  checkSum = USHRT_MAX - checkSum - 1;

  return checkSum;
};

export const createUDPHeader = (
  command: number,
  sessionId: number,
  replyId: number,
  data: Buffer
): Buffer => {
  const dataBuffer = Buffer.from(data);
  const buf = Buffer.alloc(8 + dataBuffer.length);

  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);

  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  dataBuffer.copy(buf, 8);

  const checkSum2 = createCheckSum(buf);
  buf.writeUInt16LE(checkSum2, 2);

  replyId = (replyId + 1) % USHRT_MAX;
  buf.writeUInt16LE(replyId, 6);

  return buf;
};

export const createTCPHeader = (
  command: number,
  sessionId: number,
  replyId: number,
  data: Buffer
): Buffer => {
  const dataBuffer = Buffer.from(data);
  const buf = Buffer.alloc(8 + dataBuffer.length);

  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);

  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  dataBuffer.copy(buf, 8);

  const checkSum2 = createCheckSum(buf);
  buf.writeUInt16LE(checkSum2, 2);

  replyId = (replyId + 1) % USHRT_MAX;
  buf.writeUInt16LE(replyId, 6);

  const prefixBuf = Buffer.from([
    0x50, 0x50, 0x82, 0x7d, 0x13, 0x00, 0x00, 0x00,
  ]);

  prefixBuf.writeUInt16LE(buf.length, 4);

  return Buffer.concat([prefixBuf, buf]);
};

const TCP_HEADER_SIGNATURE = Buffer.from([0x50, 0x50, 0x82, 0x7d]);

export const removeTcpHeader = (buf: Buffer): Buffer => {
  // If the buffer is too short, return it unchanged
  if (buf.length < 8) {
    return buf;
  }

  // Check if the buffer starts with the TCP header signature
  if (buf.compare(TCP_HEADER_SIGNATURE, 0, 4, 0, 4) !== 0) {
    return buf;
  }

  // Remove the first 8 bytes (the TCP header) and return the rest
  return buf.subarray(8);
};

export const decodeUserData28 = (
  userData: Buffer
): {
  uid: number;
  role: number;
  name: string | undefined;
  userId: number;
} => {
  const user = {
    uid: userData.readUIntLE(0, 2),
    role: userData.readUIntLE(2, 1),
    name: userData
      .subarray(8, 8 + 8)
      .toString("ascii")
      .split("\0")
      .shift(),
    userId: userData.readUIntLE(24, 4),
  };
  return user;
};

export const decodeUserData72 = (
  userData: Buffer
): {
  uid: number;
  role: number;
  password: string | undefined;
  name: string | undefined;
  cardno: number;
  userId: string | undefined;
} => {
  const user = {
    uid: userData.readUIntLE(0, 2),
    role: userData.readUIntLE(2, 1),
    password: userData
      .subarray(3, 3 + 8)
      .toString("ascii")
      .split("\0")
      .shift(),
    name: userData.subarray(11).toString("ascii").split("\0").shift(),
    cardno: userData.readUIntLE(35, 4),
    userId: userData
      .subarray(48, 48 + 9)
      .toString("ascii")
      .split("\0")
      .shift(),
  };
  return user;
};

export const decodeRecordData40 = (
  recordData: Buffer
): {
  userSn: number;
  deviceUserId: string | undefined;
  recordTime: string;
} => {
  const record = {
    userSn: recordData.readUIntLE(0, 2),
    deviceUserId: recordData
      .subarray(2, 2 + 9)
      .toString("ascii")
      .split("\0")
      .shift(),
    recordTime: parseTimeToDate(recordData.readUInt32LE(27)).toString(),
  };
  return record;
};

export const decodeRecordData16 = (
  recordData: Buffer
): {
  deviceUserId: number;
  recordTime: Date;
} => {
  const record = {
    deviceUserId: recordData.readUIntLE(0, 2),
    recordTime: parseTimeToDate(recordData.readUInt32LE(4)),
  };
  return record;
};

export const decodeRecordRealTimeLog18 = (
  recordData: Buffer
): {
  userId: number;
  attTime: Date;
} => {
  const userId = recordData.readUIntLE(8, 1);
  const attTime = parseHexToTime(recordData.subarray(12, 18));
  return { userId, attTime };
};

export const decodeRecordRealTimeLog52 = (
  recordData: Buffer
): {
  userId: string | undefined;
  attTime: Date;
} => {
  const payload = removeTcpHeader(recordData);

  const recvData = payload.subarray(8);

  const userId = recvData.subarray(0, 9).toString("ascii").split("\0").shift();

  const attTime = parseHexToTime(recvData.subarray(26, 26 + 6));

  return { userId, attTime };
};

export const decodeUDPHeader = (
  header: Buffer
): {
  commandId: number;
  checkSum: number;
  sessionId: number;
  replyId: number;
} => {
  const commandId = header.readUIntLE(0, 2);
  const checkSum = header.readUIntLE(2, 2);
  const sessionId = header.readUIntLE(4, 2);
  const replyId = header.readUIntLE(6, 2);
  return { commandId, checkSum, sessionId, replyId };
};

export const decodeTCPHeader = (
  header: Buffer
): {
  commandId: number;
  checkSum: number;
  sessionId: number;
  replyId: number;
  payloadSize: number;
} => {
  // Extract payload size from the header
  const payloadSize = header.readUIntLE(4, 2);

  // Extract command ID, checksum, session ID, and reply ID from the header
  const commandId = header.readUIntLE(8, 2);
  const checkSum = header.readUIntLE(10, 2);
  const sessionId = header.readUIntLE(12, 2);
  const replyId = header.readUIntLE(14, 2);

  return { commandId, checkSum, sessionId, replyId, payloadSize };
};

export const exportErrorMessage = (commandValue: number): string => {
  const keys = Object.keys(COMMANDS);
  for (let i = 0; i < keys.length; i++) {
    if ((COMMANDS as any)[keys[i]] === commandValue) {
      return keys[i].toString();
    }
  }

  return "AN UNKNOWN ERROR";
};

export const checkNotEventTCP = (data: Buffer): boolean => {
  try {
    data = removeTcpHeader(data);
    const commandId = data.readUIntLE(0, 2);
    const event = data.readUIntLE(4, 2);
    return event === COMMANDS.EF_ATTLOG && commandId === COMMANDS.CMD_REG_EVENT;
  } catch (err: any) {
    log(`[228] : ${err.toString()} ,${data.toString("hex")} `);
    return false;
  }
};

export const checkNotEventUDP = (data: Buffer): boolean => {
  const commandId = decodeUDPHeader(data.subarray(0, 8)).commandId;
  return commandId === COMMANDS.CMD_REG_EVENT;
};
