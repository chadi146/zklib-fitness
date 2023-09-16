import ZKLib from "./zklib";

const test = async (): Promise<void> => {
  const zkInstance = new ZKLib("10.20.0.7", 4370, 10000, 4000);
  try {
    // Create socket to machine
    await zkInstance.createSocket();

    // Get general info like logCapacity, user counts, logs count
    // It's really useful to check the status of device
    console.log(await zkInstance.getInfo());
  } catch (e: any) {
    console.log(e);
    if (e.code === "EADDRINUSE") {
      // Handle the specific error if necessary
    }
  }

  // Get users in machine
  const users = await zkInstance.getUsers();
  console.log(users);

  // Get all logs in the machine
  const logs = await zkInstance.getAttendances();
  console.log(logs);

  const attendances = await zkInstance.getAttendances(
    (percent: number, total: number) => {
      // this callback takes params as the percent of data downloaded and total data needed to download
    }
  );

  zkInstance.getRealTimeLogs((data: any) => {
    // do something when someone checks in
    console.log(data);
  });

  // delete the data in machine
  zkInstance.clearAttendanceLog();

  // Get the device time
  const getTime = await zkInstance.getTime();
  console.log(getTime.toString());

  // Disconnect the machine ( don't do this when you need realtime update :)))
  await zkInstance.disconnect();
};

test();
