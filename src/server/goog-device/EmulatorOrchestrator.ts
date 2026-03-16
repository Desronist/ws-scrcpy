import { exec, spawn } from 'child_process';
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
    private sdkManagerPath: string;

    constructor() {
        this.emulatorPath = process.env.EMULATOR_PATH || 'emulator';
        this.adbPath = process.env.ADB_PATH || 'adb';
        this.avdManagerPath = process.env.AVDMANAGER_PATH || 'avdmanager';
        this.sdkManagerPath = process.env.SDKMANAGER_PATH || 'sdkmanager';
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
        if (!systemImage) {
            console.error('[EmulatorOrchestrator] Failed to create emulator: systemImage is missing');
            throw new Error('Hata image bulunamadı');
        }
        const args = ['create', 'avd', '-n', name, '-k', systemImage, '--force'];
        
        console.log(`[EmulatorOrchestrator] Running: ${this.avdManagerPath} ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            const child = spawn(this.avdManagerPath, args, {
                shell: process.platform === 'win32',
                env: process.env // Ensure JAVA_HOME and other envs are passed
            });

            // Write "no" to the hardware profile question
            child.stdin.write('no\n');

            let errorOutput = '';
            child.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            child.on('exit', (code) => {
                if (code === 0) {
                    resolve({ success: true, message: `Created AVD ${name}` });
                } else {
                    console.error(`[EmulatorOrchestrator] Create failed with code ${code}. Error: ${errorOutput}`);
                    reject(new Error(`Exit code ${code}: ${errorOutput}`));
                }
            });

            child.on('error', (err) => {
                console.error(`[EmulatorOrchestrator] Spawn error during AVD creation:`, err.message);
                reject(err);
            });
        });
    }

    async getSystemImages() {
        try {
            const { stdout } = await execAsync(`"${this.sdkManagerPath}" --list_installed`);
            return stdout.split('\n')
                .filter(line => line.includes('system-images;'))
                .map(line => line.split('|')[0].trim())
                .filter(path => path.length > 0);
        } catch (err) {
            console.error(`[EmulatorOrchestrator] Error fetching system images:`, (err as Error).message);
            return [
                'Hata image bulunamadı'
            ];
        }
    }

    async deleteEmulator(avdName: string) {
        try { await this.stopEmulator(avdName); } catch (e) {}
        await execAsync(`${this.avdManagerPath} delete avd -n ${avdName}`);
        return { success: true, message: `Deleted ${avdName}` };
    }

    async installApk(avdName: string) {
        const emulators = await this.getEmulators();
        const target = emulators.find(e => e.name === avdName && e.status === 'running');
        if (!target || !target.serial) {
            throw new Error(`Emulator ${avdName} must be running to install APK.`);
        }

        const apkPath = process.env.TARGET_APK;
        if (!apkPath) {
            throw new Error('TARGET_APK environment variable is not set.');
        }

        console.log(`[EmulatorOrchestrator] Installing APK to ${target.serial} (${avdName}): ${apkPath}`);
        try {
            const { stdout, stderr } = await execAsync(`${this.adbPath} -s ${target.serial} install -r "${apkPath}"`);
            console.log(`[EmulatorOrchestrator] Install output: ${stdout}`);
            if (stderr && !stderr.includes('Success')) {
                console.warn(`[EmulatorOrchestrator] Install stderr: ${stderr}`);
            }
            return { success: true, message: `Installed APK to ${avdName}` };
        } catch (err) {
            console.error(`[EmulatorOrchestrator] Install failed for ${avdName}:`, (err as Error).message);
            throw new Error(`Installation failed: ${(err as Error).message}`);
        }
    }
}
