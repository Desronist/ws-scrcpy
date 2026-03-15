import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type EmulatorStatus = 'running' | 'booting' | 'offline';

export interface EmulatorInfo {
    name: string;
    status: EmulatorStatus;
    serial: string | null;
}

export class EmulatorOrchestrator {
    private emulatorPath: string;
    private adbPath: string;
    private avdManagerPath: string;

    constructor() {
        this.emulatorPath = process.env.EMULATOR_PATH || 'emulator';
        this.adbPath = process.env.ADB_PATH || 'adb';
        this.avdManagerPath = process.env.AVDMANAGER_PATH || 'avdmanager';
    }

    async getEmulators(): Promise<EmulatorInfo[]> {
        try {
            const { stdout: avdsOutput } = await execAsync(`${this.emulatorPath} -list-avds`);
            const avdNames = avdsOutput.trim().split('\n')
                .map(name => name.trim())
                .filter(name => name.length > 0 && !name.startsWith('INFO') && !name.startsWith('WARNING'));

            const { stdout: adbOutput } = await execAsync(`${this.adbPath} devices`);
            const runningDevices = adbOutput.split('\n')
                .slice(1)
                .filter(line => line.includes('emulator-'))
                .map(line => line.split('\t')[0].trim());

            const runningAvdMap = new Map<string, { serial: string, status: EmulatorStatus }>();
            for (const serial of runningDevices) {
                try {
                    const { stdout: nameOutput } = await execAsync(`${this.adbPath} -s ${serial} emu avd name`);
                    const name = nameOutput.trim().split('\n')[0].trim();
                    if (name) {
                        let status: EmulatorStatus = 'booting';
                        try {
                            const { stdout: bootOutput } = await execAsync(`${this.adbPath} -s ${serial} shell getprop sys.boot_completed`, { timeout: 2000 });
                            if (bootOutput.trim() === '1') {
                                status = 'running';
                            }
                        } catch (err) {}
                        runningAvdMap.set(name, { serial, status });
                    }
                } catch (err) {
                    console.error(`Could not get AVD name for ${serial}:`, (err as Error).message);
                }
            }

            return avdNames.map(name => {
                const runningInfo = runningAvdMap.get(name);
                return {
                    name,
                    status: runningInfo ? runningInfo.status : 'offline',
                    serial: runningInfo ? runningInfo.serial : null
                };
            });
        } catch (error) {
            console.error('Error fetching emulators:', error);
            throw error;
        }
    }

    async startEmulator(avdName: string) {
        console.log(`Starting emulator: ${avdName}`);
        const command = `${this.emulatorPath} -avd ${avdName}`;
        exec(command, (error) => {
            if (error && !error.killed) {
                console.error(`Emulator ${avdName} error:`, error);
            }
        });
        return { success: true, message: `Starting ${avdName}...` };
    }

    async stopEmulator(avdName: string) {
        const emulators = await this.getEmulators();
        const target = emulators.find(e => e.name === avdName && e.status === 'running');
        if (!target || !target.serial) {
            throw new Error(`Emulator ${avdName} is not running.`);
        }
        await execAsync(`${this.adbPath} -s ${target.serial} emu kill`);
        return { success: true, message: `Stopped ${avdName}` };
    }

    async createEmulator(name: string, systemImage?: string) {
        const defaultImage = 'system-images;android-30;google_apis_playstore;arm64-v8a';
        const imageToUse = systemImage || defaultImage;
        const command = `echo "no" | ${this.avdManagerPath} create avd -n "${name}" -k "${imageToUse}" --force`;
        await execAsync(command);
        return { success: true, message: `Created AVD ${name}` };
    }

    async getSystemImages() {
        try {
            const sdkPath = this.avdManagerPath.split('/cmdline-tools')[0];
            const sdkManagerPath = `${sdkPath}/cmdline-tools/latest/bin/sdkmanager`;
            const { stdout } = await execAsync(`${sdkManagerPath} --list_installed`);
            return stdout.split('\n')
                .filter(line => line.includes('system-images;'))
                .map(line => line.split('|')[0].trim())
                .filter(path => path.length > 0);
        } catch (err) {
            return [
                'system-images;android-30;google_apis_playstore;arm64-v8a',
                'system-images;android-35;google_apis_playstore;arm64-v8a'
            ];
        }
    }

    async deleteEmulator(avdName: string) {
        try { await this.stopEmulator(avdName); } catch (e) {}
        await execAsync(`${this.avdManagerPath} delete avd -n ${avdName}`);
        return { success: true, message: `Deleted ${avdName}` };
    }
}
