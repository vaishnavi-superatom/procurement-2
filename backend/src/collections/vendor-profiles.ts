import { queryProcurement } from '../services/procurement-source';
import { requestAuthor } from '../services/request-author';
import type { CollectionContext } from './types';

/**
 * Vendor profile pictures (walkthrough, 16 Oct: "a circular profile picture
 * that can be uploaded"), stored in the procurement database next to the
 * vendors. The screen shrinks each picture to a small square JPEG before
 * sending it, so it is kept as a data URL. The table was created once with:
 *
 *   CREATE TABLE public.vendor_profile_photos (
 *     vendor_id varchar(50) PRIMARY KEY,
 *     photo text NOT NULL,
 *     updated_by varchar(255),
 *     updated_by_id varchar(255),
 *     updated_at timestamptz NOT NULL DEFAULT now()
 *   );
 *
 * Writing needs the source's writeMode to be at least 'dml'.
 */

const VENDOR_ID = /^[A-Za-z0-9_-]{1,50}$/;
// The screen sends a 256 px JPEG (typically 15–40 KB); anything far bigger isn't from it.
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_PHOTO_LENGTH = 400_000;

const PHOTO_COLUMNS = `photo, updated_by AS "updatedBy", updated_at AS "updatedAt"`;

function requireVendorId(value: unknown): string {
	if (typeof value !== 'string' || !VENDOR_ID.test(value)) {
		throw new Error('A valid vendorId is required');
	}
	return value;
}

export async function registerVendorProfilesCollections({ sdk }: CollectionContext): Promise<void> {
	// The vendor's picture, or null when none was uploaded.
	sdk.addCollection('vendor-profiles', 'get-photo', async (params: any) => {
		const vendorId = requireVendorId(params?.vendorId);
		const [row] = await queryProcurement('vendor-photo-get',
			`SELECT ${PHOTO_COLUMNS} FROM vendor_profile_photos WHERE vendor_id = @vendorId`, { vendorId });
		return { success: true, data: row ?? null };
	});

	// Add or replace the vendor's picture.
	sdk.addCollection('vendor-profiles', 'set-photo', async (params: any) => {
		const vendorId = requireVendorId(params?.vendorId);
		const photo = typeof params?.photo === 'string' ? params.photo : '';
		if (photo.length > MAX_PHOTO_LENGTH) throw new Error('This picture is too large; please choose a smaller one');
		if (!PHOTO.test(photo)) throw new Error('Please choose a JPEG, PNG or WebP picture');

		const { userId, userName } = requestAuthor(params);
		const [vendor] = await queryProcurement('vendor-photo-vendor', `SELECT vendor_id FROM vendor_master WHERE vendor_id = @vendorId`, { vendorId });
		if (!vendor) throw new Error(`Vendor ${vendorId} not found`);

		const [row] = await queryProcurement('vendor-photo-set', `
			INSERT INTO vendor_profile_photos (vendor_id, photo, updated_by, updated_by_id)
			VALUES (@vendorId, @photo, @updatedBy, @updatedById)
			ON CONFLICT (vendor_id) DO UPDATE
			SET photo = EXCLUDED.photo, updated_by = EXCLUDED.updated_by, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()
			RETURNING ${PHOTO_COLUMNS}`,
			{ vendorId, photo, updatedBy: userName ?? null, updatedById: userId ?? null });
		console.log(`[VENDOR-PROFILES] Photo for ${vendorId} set by ${userName || userId || 'anonymous'} (${Math.round(photo.length / 1024)} KB)`);
		return { success: true, data: row };
	});

	// Remove the vendor's picture (the profile falls back to initials).
	sdk.addCollection('vendor-profiles', 'remove-photo', async (params: any) => {
		const vendorId = requireVendorId(params?.vendorId);
		await queryProcurement('vendor-photo-remove', `DELETE FROM vendor_profile_photos WHERE vendor_id = @vendorId`, { vendorId });
		console.log(`[VENDOR-PROFILES] Photo for ${vendorId} removed`);
		return { success: true, data: null };
	});
}
