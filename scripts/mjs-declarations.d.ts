declare module "*.mjs" {
  export interface PackagedRollbackSmokeResult {
    passed: true;
    currentVersion: string;
    restoredVersion: string;
    injectedFailureStatus: number;
    noStaleProcess: true;
    noProfileLock: true;
  }

  export function runPackagedRollbackSmoke(): Promise<PackagedRollbackSmokeResult>;
}
