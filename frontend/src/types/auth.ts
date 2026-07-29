export interface CertInfo {
  authenticated: boolean;
  scheme: string;
  display_name: string;
  /** Extracted from CN — e.g. "谢林" */
  name: string;
  /** Extracted from CN — e.g. "320100198601010018" */
  id_number: string;
}
