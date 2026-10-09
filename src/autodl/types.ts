export interface AutoDLApiResponse<T = unknown> {
  code: string;
  msg: string;
  data: T;
  request_id?: string;
}

export interface SafeInstanceSnapshot {
  instance_uuid: string;
  status: string;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: 'root';
  connection_warning?: string;
}

export interface InstanceApi {
  powerOn(instanceUuid: string, signal?: AbortSignal): Promise<AutoDLApiResponse<null>>;
  powerOff(instanceUuid: string, signal?: AbortSignal): Promise<AutoDLApiResponse<null>>;
  getStatus(instanceUuid: string, signal?: AbortSignal): Promise<string>;
}
