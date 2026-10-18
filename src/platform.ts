import { release } from "node:os";

export interface PlatformSupport {
  supported: boolean;
  message: string;
}

const minimumVersion = "macOS 26";

export function getPlatformSupport(platform: string = process.platform, kernelRelease: string = release()): PlatformSupport {
  if (platform !== "darwin") {
    return { supported: false, message: `${minimumVersion} or later is required.` };
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(kernelRelease);
  if (!match || match.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) {
    return { supported: false, message: `Cannot determine the macOS kernel version. ${minimumVersion} or later is required.` };
  }
  const kernelMajor = Number(match[1]);
  if (kernelMajor < 25) {
    return {
      supported: false,
      message: `${minimumVersion} or later is required (current Darwin kernel: ${kernelRelease}).`
    };
  }
  return { supported: true, message: `Operating system: ${minimumVersion} or later (Darwin ${kernelRelease})` };
}

export function assertSupportedPlatform(platform: string = process.platform, kernelRelease: string = release()): void {
  const support = getPlatformSupport(platform, kernelRelease);
  if (!support.supported) throw new Error(support.message);
}
