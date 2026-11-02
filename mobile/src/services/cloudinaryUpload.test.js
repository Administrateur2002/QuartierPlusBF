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

    slice(_start, _end, type) {
      return new Blob(["video-part"], { type });
    }
  },
}));

jest.mock("./api", () => ({
  API_BASE_URL: "https://api.example.test",
  apiFetch: jest.fn(async () => ({ ok: true, status: 204 })),
}));

const axios = require("axios").default;
const { apiFetch } = require("./api");
const { uploadCloudinaryMedia } = require("./cloudinaryUpload");

describe("Cloudinary signed uploads", () => {
  beforeEach(() => {
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { public_id: "user_video" } });
    apiFetch.mockClear();
  });

  it("sends large videos as chunks with identical signed parameters", async () => {
    const signature = {
      apiKey: "public-api-key",
      cloudName: "test-cloud",
      folder: "quartierplus/posts",
      public_id: "user_video",
      resource_type: "video",
      signature: "signed-value",
      timestamp: 123,
    };
    const result = await uploadCloudinaryMedia(signature, {
      uri: "file:///video.mp4",
      name: "video.mp4",
      type: "video/mp4",
      size: 20 * 1024 * 1024 + 1,
    });

    expect(result).toEqual({ publicId: "user_video" });
    expect(axios.post).toHaveBeenCalledTimes(5);
    const firstCall = axios.post.mock.calls[0];
    expect(firstCall[0]).toBe(
      "https://api.cloudinary.com/v1_1/test-cloud/video/upload",
    );
    expect(firstCall[1].get("api_key")).toBe("public-api-key");
    expect(firstCall[1].get("timestamp")).toBe("123");
    expect(firstCall[1].get("folder")).toBe("quartierplus/posts");
    expect(firstCall[1].get("public_id")).toBe("user_video");
    expect(firstCall[1].get("signature")).toBe("signed-value");
    expect(firstCall[2].headers).toEqual({
      "Content-Range": "bytes 0-5242879/20971521",
      "X-Unique-Upload-Id": "user_video",
    });
    expect(axios.post.mock.calls.at(-1)[2].headers["Content-Range"]).toBe(
      "bytes 20971520-20971520/20971521",
    );
  });

  it("chunks small videos and reports progress while each chunk uploads", async () => {
    const signature = {
      apiKey: "public-api-key",
      cloudName: "test-cloud",
      folder: "quartierplus/posts",
      public_id: "user_video",
      resource_type: "video",
      signature: "signed-value",
      timestamp: 123,
    };
    const onProgress = jest.fn();
    axios.post.mockImplementation(async (_url, _formData, options) => {
      options.onUploadProgress({ loaded: 3, total: 3 });
      return { data: { public_id: "user_video" } };
    });

    await uploadCloudinaryMedia(
      signature,
      {
        uri: "file:///small-video.mp4",
        name: "small-video.mp4",
        type: "video/mp4",
        size: 3,
      },
      { onProgress },
    );

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][2].headers["Content-Range"]).toBe(
      "bytes 0-2/3",
    );
    expect(onProgress).toHaveBeenLastCalledWith(90);
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
