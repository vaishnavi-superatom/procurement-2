// Vendor profile pictures — stored by the backend's `vendor-profiles`
// collection in the procurement database, next to the vendors.
import { requestCollection } from './collection-request';
import { getSignedInUser } from './signed-in-user';

export interface VendorPhoto {
  /** A data URL (a small square JPEG). */
  photo: string;
  updatedBy: string | null;
  updatedAt: string;
}

export const getVendorPhoto = (vendorId: string): Promise<VendorPhoto | null> =>
  requestCollection<VendorPhoto | null>('vendor-profiles', 'get-photo', { vendorId });

export const setVendorPhoto = (vendorId: string, photo: string): Promise<VendorPhoto> => {
  const { userId, userName } = getSignedInUser();
  return requestCollection<VendorPhoto>('vendor-profiles', 'set-photo', { vendorId, photo, userId, userName });
};

export const removeVendorPhoto = (vendorId: string): Promise<null> =>
  requestCollection<null>('vendor-profiles', 'remove-photo', { vendorId });

/** Shrinks a picked image to a centred square JPEG data URL, small enough to store with the vendor. */
export async function toProfilePhoto(file: File, size = 256): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read this picture"));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Couldn't process this picture");
    ctx.fillStyle = '#FFFFFF'; // transparent logos get a white background
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
