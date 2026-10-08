/**
 * AutoDL API 响应基础信封
 */
export interface AutoDLApiResponse<T = unknown> {
  code: string; // 成功时为 "Success"
  msg: string;  // 错误信息，成功时为空 ""
  data: T;
  request_id?: string;
}

/**
 * 实例使用率监控指标
 */
export interface InstanceUsageInfo {
  container_id?: string;
  valid_at?: string;
  cpu_usage_percent?: number;
  mem_usage_percent?: number;
  mem_usage?: number;
  mem_limit?: number;
  root_fs_used_size?: number;
  root_fs_total_size?: number;
  data_disk_total_size?: number;
  data_disk_used_size?: number;
  pull_image_progress?: number;
  download_image_progress?: number;
  is_new?: boolean;
  valid?: boolean;
}

/**
 * AutoDL 官方返回的实例详情（原始数据，包含敏感字段）
 */
export interface RawInstanceSnapshot {
  region_sign: string;
  payg_price: number;
  origin_pay_price: number;
  snapshot_gpu_alias_name: string;
  chip_corp: string;
  cpu_arch: string;
  usage_info?: InstanceUsageInfo;
  expand_system_disk_size?: number;
  system_init_disk_size?: number;
  ssh_command?: string;
  proxy_host: string;
  root_password?: string; // 敏感信息！必须向 Agent 过滤
  ssh_port: number;
  jupyter_token?: string;
  jupyter_domain?: string;
  service_6006_domain?: string;
  service_6006_port_protocol?: string;
  service_6008_domain?: string;
  service_6008_port_protocol?: string;
}

/**
 * 面向 AI Agent 的安全实例连接详情（已安全脱敏，无密码泄露）
 */
export interface SafeInstanceSnapshot {
  instance_uuid: string;
  status: string;
  region: string;
  gpu_name: string;
  payg_price_per_hour_cny: number;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string; // 固定为 root
  ssh_connect_command: string; // 例如: ssh -p 34222 root@connect.xxx.autodl.com
  jupyter_url?: string;
  service_6006_url?: string;
  service_6008_url?: string;
  usage?: {
    cpu_usage_percent?: number;
    mem_usage_percent?: number;
    root_fs_used_gb?: number;
    root_fs_total_gb?: number;
  };
}

/**
 * 实例列表条目
 */
export interface InstanceListItem {
  uuid: string;
  name: string;
  status: string;
  region_sign: string;
  region_name: string;
  gpu_spec_uuid: string;
  req_gpu_amount: number;
  charge_type: string;
  created_at: string;
  status_at?: string;
}

/**
 * 实例列表响应数据
 */
export interface InstanceListResult {
  list: InstanceListItem[];
  page_index: number;
  page_size: number;
  max_page: number;
  result_total: number;
}

/**
 * 账户余额
 */
export interface WalletBalance {
  assets: number; // 除以 1000 为元
  assets_cny: number;
  accumulate: number;
  voucher_balance: number;
  voucher_balance_cny: number;
}
