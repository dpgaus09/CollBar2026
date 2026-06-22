// ---------------------------------------------------------------------------
// Google Drive helper for customer document submissions.
//
// Customer-uploaded salary schedules and CBA PDFs are forwarded to the admin's
// Google Drive, into a "CollBar Customer Submissions" folder with one subfolder
// per district. The admin reviews them there and loads good ones via the admin
// upload tool.
//
// NOTE: The real Drive client (built from the Replit Google Drive connector
// snippet) is wired up once the integration is connected. Until then,
// uploadCustomerSubmission throws DriveNotConnectedError so the API degrades
// gracefully instead of crashing.
// ---------------------------------------------------------------------------

export interface CustomerSubmission {
  districtId: number;
  districtName: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
}

export interface UploadResult {
  fileId: string;
  name: string;
  webViewLink?: string | null;
}

export class DriveNotConnectedError extends Error {
  constructor(message = "Google Drive is not connected") {
    super(message);
    this.name = "DriveNotConnectedError";
  }
}

export async function uploadCustomerSubmission(
  _submission: CustomerSubmission,
): Promise<UploadResult> {
  throw new DriveNotConnectedError();
}
