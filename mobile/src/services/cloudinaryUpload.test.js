jest.mock("axios", () => ({
  __esModule: true,
  default: {
    isAxiosError: jest.fn((error) => Boolean(error?.response)),
    post: jest.fn(),
  },
}));

jest.mock("expo-file-system", () => ({
  File: class MockFile {
    constructor(uri) {
      this.uri = uri;
      this.size = 20 * 1024 * 1024 + 1;
    }
  },
}));

jest.mock("./api", () => ({
  API_BASE_URL: "https://api.example.test",
  apiFetch: jest.fn(async () => ({ ok: true, status: 204 })),
}));

const OriginalFormData = global.FormData;
class ReactNativeFormDataMock {
  constructor() {
    this.values = new Map();
  }

  append(name, value) {
    this.values.set(name, value);
  }

  get(name) {
    return this.values.get(name) ?? null;
  }
}

global.FormData = ReactNativeFormDataMock;

const axios = require("axios").default;
const { apiFetch } = require("./api");
const { uploadCloudinaryMedia } = require("./cloudinaryUpload");

describe("Cloudinary signed uploads", () => {
  afterAll(() => {
    global.FormData = OriginalFormData;
  });

  beforeEach(() => {
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { public_id: "user_video" } });
    apiFetch.mockClear();
  });

  it("uploads MP4 videos as React Native URI form data and returns Cloudinary response", async () => {
    const signature = {
      apiKey: "public-api-key",
      cloudName: "test-cloud",
      folder: "quartierplus/posts",
      public_id: "user_video",
      resource_type: "video",
      signature: "signed-value",
      timestamp: 123,
    };
    const secureUrl =
      "https://res.cloudinary.com/test-cloud/video/upload/user_video.mp4";
    const onProgress = jest.fn();
    axios.post.mockResolvedValue({
      data: { public_id: "user_video", secure_url: secureUrl },
    });
    const result = await uploadCloudinaryMedia(
      signature,
      {
        uri: "file:///video.mp4",
        name: "video.mp4",
        type: "video/mp4",
        size: 20 * 1024 * 1024 + 1,
      },
      { onProgress },
    );

    expect(result).toEqual({ publicId: "user_video", secureUrl });
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, formData, options] = axios.post.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudinary.com/v1_1/test-cloud/video/upload",
    );
    expect(formData.get("file")).toEqual({
      uri: "file:///video.mp4",
      name: "video.mp4",
      type: "video/mp4",
    });
    expect(formData.get("api_key")).toBe("public-api-key");
    expect(formData.get("timestamp")).toBe("123");
    expect(formData.get("folder")).toBe("quartierplus/posts");
    expect(formData.get("public_id")).toBe("user_video");
    expect(formData.get("signature")).toBe("signed-value");
    expect(options.headers).toBeUndefined();
    expect(onProgress).toHaveBeenLastCalledWith(90);
  });

  it("uploads photos as React Native URI form data", async () => {
    const signature = {
      apiKey: "public-api-key",
      cloudName: "test-cloud",
      folder: "quartierplus/posts",
      public_id: "user_photo",
      resource_type: "image",
      signature: "signed-value",
      timestamp: 123,
    };
    axios.post.mockResolvedValue({ data: { public_id: "user_photo" } });
    await uploadCloudinaryMedia(signature, {
      uri: "file:///photo.jpg",
      name: "photo.jpg",
      type: "image/jpeg",
      size: 3,
    });
    const [url, formData] = axios.post.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudinary.com/v1_1/test-cloud/image/upload",
    );
    expect(formData.get("file")).toEqual({
      uri: "file:///photo.jpg",
      name: "photo.jpg",
      type: "image/jpeg",
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it("accepts and returns the public ID prefixed by the signed folder", async () => {
    const signature = {
      apiKey: "public-api-key",
      cloudName: "test-cloud",
      folder: "quartierplus/posts",
      public_id: "user_photo",
      resource_type: "video",
      signature: "signed-value",
      timestamp: 123,
    };
    const secureUrl = "https://res.cloudinary.com/test-cloud/video/upload/video.mp4";
    axios.post.mockResolvedValue({
      data: {
        public_id: "quartierplus/posts/user_photo",
        secure_url: secureUrl,
      },
    });

    await expect(
      uploadCloudinaryMedia(signature, {
        uri: "file:///photo.jpg",
        name: "photo.mp4",
        type: "video/mp4",
        size: 20 * 1024 * 1024 + 1,
      }),
    ).resolves.toEqual({
      publicId: "quartierplus/posts/user_photo",
      secureUrl,
    });
  });

  it("accepts an expected public ID under an account-managed dynamic folder", async () => {
    const signature = {
      apiKey: "public-api-key",
      cloudName: "test-cloud",
      folder: "quartierplus/posts",
      public_id: "user_photo",
      resource_type: "video",
      signature: "signed-value",
      timestamp: 123,
    };
    const secureUrl =
      "https://res.cloudinary.com/test-cloud/video/upload/dynamic/folder/user_photo.mp4";
    axios.post.mockResolvedValue({
      data: {
        public_id: "dynamic/folder/user_photo",
        secure_url: secureUrl,
      },
    });

    await expect(
      uploadCloudinaryMedia(signature, {
        uri: "file:///photo.jpg",
        name: "photo.mp4",
        type: "video/mp4",
        size: 20 * 1024 * 1024 + 1,
      }),
    ).resolves.toEqual({
      publicId: "dynamic/folder/user_photo",
      secureUrl,
    });
  });

  it("logs and reports expected and received IDs when Cloudinary returns an invalid ID", async () => {
    const signature = {
      apiKey: "public-api-key",
      cloudName: "test-cloud",
      folder: "quartierplus/posts",
      public_id: "user_video",
      resource_type: "video",
      signature: "signed-value",
      timestamp: 123,
    };
    axios.post.mockResolvedValue({ data: { public_id: "unexpected_id" } });
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      await expect(
        uploadCloudinaryMedia(signature, {
          uri: "file:///video.mp4",
          name: "video.mp4",
          type: "video/mp4",
          size: 20 * 1024 * 1024 + 1,
        }),
      ).rejects.toThrow("identifiant public inattendu");

      expect(consoleError).toHaveBeenCalledWith(
        "Cloudinary upload failed:",
        expect.objectContaining({
          expectedPublicId: "user_video",
          receivedPublicId: "unexpected_id",
        }),
      );
      expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual(
        expect.objectContaining({
          expected_public_id: "user_video",
          received_public_id: "unexpected_id",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
