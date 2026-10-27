import * as ImageManipulator from "expo-image-manipulator";
import { File } from "expo-file-system";
import api from "./api";
import { uploadCloudinaryMedia, type CloudinaryUploadSignature } from "./cloudinaryUpload";

type ProductPhotoSignature = CloudinaryUploadSignature & { max_bytes: number };

export const uploadProProductPhoto = async (uri: string) => {
  let optimizedUri = uri;
  let size = Number.POSITIVE_INFINITY;
  for (const [width, quality] of [[1280, 0.6], [1024, 0.45], [800, 0.3], [640, 0.2]]) {
    const optimized = await ImageManipulator.manipulateAsync(
      optimizedUri,
      [{ resize: { width } }],
      { compress: quality, format: ImageManipulator.SaveFormat.WEBP },
    );
    optimizedUri = optimized.uri;
    size = new File(optimizedUri).size;
    if (Number.isFinite(size) && size <= 300 * 1024) break;
  }
  if (!Number.isFinite(size) || size > 300 * 1024) {
    throw new Error("La photo du produit ne peut pas être compressée sous 300 Ko.");
  }
  const response = await api.post<ProductPhotoSignature>("/v1/pro-commerce/products/photo-signature");
  if (size > response.data.max_bytes) {
    throw new Error("La photo dépasse la taille maximale autorisée par le serveur.");
  }
  const upload = await uploadCloudinaryMedia(response.data, {
    uri: optimizedUri,
    name: "quartierplus-pro-product.webp",
    type: "image/webp",
    size,
  });
  return upload.publicId;
};
