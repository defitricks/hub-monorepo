import { HttpAPIServer, protoToJSON } from "../httpServer.js";
import { jestRocksDB } from "../../storage/db/jestUtils.js";
import {
  bytesToHexString,
  CastAddMessage,
  Factories,
  FarcasterNetwork,
  LinkAddMessage,
  Message,
  MessageType,
  OnChainEvent,
  onChainEventTypeToJSON,
  ReactionAddMessage,
  ReactionType,
  reactionTypeToJSON,
  toFarcasterTime,
  UserDataAddMessage,
  UserDataType,
  UsernameProofMessage,
  UserNameType,
  utf8StringToBytes,
  VerificationAddEthAddressMessage,
  clients,
} from "@farcaster/hub-nodejs";
import Engine from "../../storage/engine/index.js";
import { MockHub } from "../../test/mocks.js";
import { jest } from "@jest/globals";
import Server from "../server.js";
import SyncEngine from "../../network/sync/syncEngine.js";
import axios from "axios";
import { faker } from "@faker-js/faker";
import { DeepPartial } from "fishery";
import { mergeDeepPartial } from "../../test/utils.js";
import { IdRegisterOnChainEvent } from "@farcaster/core";
import { APP_VERSION } from "../../hubble.js";
import { connect } from "@farcaster/hub-nodejs";
import { PublicClient, zeroAddress } from "viem";

const publicClient = clients.defaultL2PublicClient as PublicClient;

const db = jestRocksDB("httpserver.rpc.server.test");
const network = FarcasterNetwork.TESTNET;
const engine = new Engine(db, network, undefined, publicClient);
const hub = new MockHub(db, engine);

let syncEngine: SyncEngine;
let server: Server;
let httpServer: HttpAPIServer;
let httpServerAddress: string;

function getFullUrl(path: string) {
  return `${httpServerAddress}${path}`;
}

beforeAll(async () => {
  syncEngine = new SyncEngine(hub, db);
  server = new Server(hub, engine, syncEngine);
  httpServer = new HttpAPIServer(server.getImpl(), engine, publicClient);
  httpServerAddress = (await httpServer.start())._unsafeUnwrap();
});

afterAll(async () => {
  await syncEngine.stop();
  await httpServer.stop();
  await engine.stop();
  await server.stop();
});

const fid = Factories.Fid.build();
const signer = Factories.Ed25519Signer.build();
const custodySigner = Factories.Eip712Signer.build();

let custodyEvent: IdRegisterOnChainEvent;
let signerEvent: OnChainEvent;
let storageEvent: OnChainEvent;

let timestamp = toFarcasterTime(Date.now())._unsafeUnwrap();

describe("httpServer", () => {
  beforeAll(async () => {
    const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
    const custodySignerKey = (await custodySigner.getSignerKey())._unsafeUnwrap();
    custodyEvent = Factories.IdRegistryOnChainEvent.build({ fid }, { transient: { to: custodySignerKey } });
    signerEvent = Factories.SignerOnChainEvent.build({ fid }, { transient: { signer: signerKey } });
    storageEvent = Factories.StorageRentOnChainEvent.build({ fid });
  });

  beforeEach(async () => {
    await engine.mergeOnChainEvent(custodyEvent);
    await engine.mergeOnChainEvent(signerEvent);
    await engine.mergeOnChainEvent(storageEvent);
  });

  describe("cors", () => {
    test("cors", async () => {
      const syncEngine = new SyncEngine(hub, db);
      const server = new Server(hub, engine, syncEngine);
      const httpServer = new HttpAPIServer(server.getImpl(), engine, publicClient, "http://example.com");
      const addr = (await httpServer.start())._unsafeUnwrap();

      const url = `${addr}/v1/info`;
      const response = await axios.get(url, { headers: { Origin: "http://example.com" } });

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://example.com");

      await httpServer.stop();
      await server.stop();
      await syncEngine.stop();
    });
  });

  describe("getInfo", () => {
    test("getInfo", async () => {
      const url = getFullUrl("/v1/info");
      const response = await axios.get(url);

      expect(response.status).toBe(200);
      expect(response.data.version).toEqual(APP_VERSION);
    });
  });

  describe("submit APIs", () => {
    let castAdd: CastAddMessage;

    beforeAll(async () => {
      castAdd = await Factories.CastAddMessage.create({ data: { fid, network, timestamp } }, { transient: { signer } });
    });

    test("submitCast binary", async () => {
      const postConfig = { headers: { "Content-Type": "application/octet-stream" } };
      const url = getFullUrl("/v1/submitMessage");

      // Encode the message into a Buffer (of bytes)
      const messageBytes = Buffer.from(Message.encode(castAdd).finish());
      const response = await axios.post(url, messageBytes, postConfig);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(protoToJSON(castAdd, Message));

      let errored = false;
      try {
        // Post bad data
        await axios.post(url, Buffer.from("bad data"), postConfig);
      } catch (e) {
        errored = true;
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        expect((e as any).response.status).toBe(400);
      }
      expect(errored).toBeTruthy();
    });

    test("submit with auth", async () => {
      const rpcAuth = "username:password";
      const authGrpcServer = new Server(hub, engine, syncEngine, undefined, rpcAuth);
      const authServer = new HttpAPIServer(authGrpcServer.getImpl(), engine, publicClient);
      const addr = (await authServer.start())._unsafeUnwrap();

      const postConfig = {
        headers: { "Content-Type": "application/octet-stream" },
        auth: { username: "username", password: "password" },
      };

      const url = `${addr}/v1/submitMessage`;
      // Encode the message into a Buffer (of bytes)
      const messageBytes = Buffer.from(Message.encode(castAdd).finish());

      // Doesn't work if you don't pass auth
      let errored = false;
      try {
        await axios.post(url, messageBytes, { headers: { "Content-Type": "application/octet-stream" } });
      } catch (e) {
        errored = true;
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        const response = (e as any).response;

        expect(response.status).toBe(400);
        expect(response.data.errCode).toEqual("unauthenticated");
        expect(response.data.details).toContain("Authorization header is empty");
      }

      // Doesn't work with a bad password
      errored = false;
      try {
        await axios.post(url, messageBytes, { ...postConfig, auth: { username: "username", password: "badpassword" } });
      } catch (e) {
        errored = true;

        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        const response = (e as any).response;

        expect(response.status).toBe(400);
        expect(response.data.errCode).toEqual("unauthenticated");
      }

      // Right password works
      const response = await axios.post(url, messageBytes, postConfig);
      expect(response.status).toBe(200);

      await authServer.stop();
    });
  });

  describe("HubEvents APIs", () => {
    let castAdd: CastAddMessage;

    beforeAll(async () => {
      castAdd = await Factories.CastAddMessage.create({ data: { fid, network, timestamp } }, { transient: { signer } });
    });

    test("getHubEvents", async () => {
      expect((await engine.mergeMessage(castAdd)).isOk()).toBeTruthy();

      // Get a http client for port 2181
      const url = getFullUrl("/v1/events?from_event_id=0");
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data.events.length).toEqual(4); // idRegistry, custody, signerAdd, castAdd
      expect(response.data.events[3].mergeMessageBody.message).toEqual(protoToJSON(castAdd, Message));

      const signerAddEventId = response.data.events[2].id;
      const castAddEventId = response.data.events[3].id;

      // Get the castAdd event directly by ID
      const url0 = getFullUrl(`/v1/eventById?event_id=${castAddEventId}`);
      const response0 = await axiosGet(url0);

      expect(response0.status).toBe(200);
      expect(response0.data.mergeMessageBody.message).toEqual(protoToJSON(castAdd, Message));

      // Get the events starting after the signerAdd but before the castAdd
      const url1 = getFullUrl(`/v1/events?from_event_id=${signerAddEventId + 1}`);
      const response1 = await axiosGet(url1);

      expect(response1.status).toBe(200);
      expect(response1.data.events.length).toEqual(1);
      expect(response1.data.events[0].mergeMessageBody.message).toEqual(protoToJSON(castAdd, Message));

      // Now, get the events starting at the last eventID
      const url2 = getFullUrl(`/v1/events?from_event_id=${castAddEventId}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data.events.length).toEqual(1);
      expect(response2.data.events[0].mergeMessageBody.message).toEqual(protoToJSON(castAdd, Message));

      // Getthe events starting at the nextEventId  should return nothing
      const url3 = getFullUrl(`/v1/events?from_event_id=${response2.data.nextPageEventId}`);
      const response3 = await axiosGet(url3);

      expect(response3.status).toBe(200);
      expect(response3.data.events.length).toEqual(0);
      expect(response3.data.nextPageEventId).toBe(response2.data.nextPageEventId + 1);
    });
  });

  describe("FID APIs", () => {
    test("fid", async () => {
      // Get a http client for port 2181
      const url = getFullUrl("/v1/fids");
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data.fids).toEqual([fid]);
    });
  });

  describe("cast APIs", () => {
    let castAdd: CastAddMessage;

    beforeAll(async () => {
      castAdd = await Factories.CastAddMessage.create({ data: { fid, network, timestamp } }, { transient: { signer } });
    });

    const newCastAdd = async (params?: DeepPartial<CastAddMessage>) => {
      timestamp++;
      const defaults: DeepPartial<CastAddMessage> = { data: { fid, network, timestamp } };
      const merged = mergeDeepPartial(defaults, params ?? {});
      return await Factories.CastAddMessage.create(merged, { transient: { signer } });
    };

    test("getCast", async () => {
      expect((await engine.mergeMessage(castAdd)).isOk()).toBeTruthy();

      // Get a http client for port 2181
      const hashHex = bytesToHexString(castAdd.hash)._unsafeUnwrap();
      const url = getFullUrl(`/v1/castById?fid=${fid}&hash=${hashHex}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(protoToJSON(castAdd, Message));
      expect(response.data.hash).toBe(hashHex);
      expect(response.data.signer).toBe(
        bytesToHexString(signerEvent.signerEventBody?.key ?? new Uint8Array())._unsafeUnwrap(),
      );

      // Merge in a new cast
      const newCast = await newCastAdd();
      expect((await engine.mergeMessage(newCast)).isOk()).toBeTruthy();

      // Get the new cast as a part of getAllCasts
      const url2 = getFullUrl(`/v1/castsByFid?fid=${fid}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data.messages).toEqual([protoToJSON(castAdd, Message), protoToJSON(newCast, Message)]);

      // Make sure paging works
      const url4 = getFullUrl(`/v1/castsByFid?fid=${fid}&pageSize=1`);
      const response4 = await axiosGet(url4);

      expect(response4.status).toBe(200);
      expect(response4.data.messages).toEqual([protoToJSON(castAdd, Message)]);

      // get the next page
      const url5 = getFullUrl(`/v1/castsByFid?fid=${fid}&pageToken=${response4.data.nextPageToken}`);
      const response5 = await axiosGet(url5);

      expect(response5.status).toBe(200);
      expect(response5.data.messages).toEqual([protoToJSON(newCast, Message)]);
      expect(response5.data.nextPageToken).toBe("");

      // Make sure reverse works
      const url3 = getFullUrl(`/v1/castsByFid?fid=${fid}&reverse=true`);
      const response3 = await axiosGet(url3);

      expect(response3.status).toBe(200);
      expect(response3.data.messages).toEqual([protoToJSON(newCast, Message), protoToJSON(castAdd, Message)]);
    });

    test("getCastByParent", async () => {
      expect((await engine.mergeMessage(castAdd)).isOk()).toBeTruthy();

      // Get a http client for port 2181
      const parentFid = castAdd.data.castAddBody.parentCastId?.fid;
      const hashHex = bytesToHexString(castAdd.data.castAddBody.parentCastId?.hash ?? new Uint8Array())._unsafeUnwrap();
      const url = getFullUrl(`/v1/castsByParent?fid=${parentFid}&hash=${hashHex}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data.messages).toEqual([protoToJSON(castAdd, Message)]);

      // Also try it get it via URL
      const castAdd2 = await newCastAdd({
        data: { castAddBody: { parentCastId: undefined, parentUrl: faker.internet.url() } },
      });
      expect((await engine.mergeMessage(castAdd2)).isOk()).toBeTruthy();

      const encoded = encodeURIComponent(castAdd2.data.castAddBody.parentUrl ?? "");
      const url2 = getFullUrl(`/v1/castsByParent?url=${encoded}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data.messages).toEqual([protoToJSON(castAdd2, Message)]);
    });

    test("getCastByMention", async () => {
      expect((await engine.mergeMessage(castAdd)).isOk()).toBeTruthy();

      // Get a http client for port 2181
      for (let i = 0; i < castAdd.data.castAddBody.mentions.length; i++) {
        const url = getFullUrl(`/v1/castsByMention?fid=${castAdd.data.castAddBody.mentions[i]}`);
        const response = await axiosGet(url);

        expect(response.status).toBe(200);
        expect(response.data.messages).toEqual([protoToJSON(castAdd, Message)]);
      }
    });
  });

  describe("reaction APIs", () => {
    let castAdd: CastAddMessage;
    let reaction: Message;

    beforeAll(async () => {
      castAdd = await Factories.CastAddMessage.create({ data: { fid, network, timestamp } }, { transient: { signer } });
      reaction = await Factories.ReactionAddMessage.create(
        { data: { fid, network, timestamp, reactionBody: { targetCastId: { fid, hash: castAdd.hash } } } },
        { transient: { signer } },
      );
    });

    const newReactionAdd = async (params?: DeepPartial<ReactionAddMessage>) => {
      timestamp++;
      const defaults: DeepPartial<ReactionAddMessage> = { data: { fid, network, timestamp } };
      const merged = mergeDeepPartial(defaults, params ?? {});
      return await Factories.ReactionAddMessage.create(merged, { transient: { signer } });
    };

    test("getReaction", async () => {
      expect((await engine.mergeMessage(castAdd)).isOk()).toBeTruthy();
      expect((await engine.mergeMessage(reaction)).isOk()).toBeTruthy();

      // Get a http client for port 2181
      const castHashHex = bytesToHexString(castAdd.hash)._unsafeUnwrap();
      const url = getFullUrl(
        `/v1/reactionById?fid=${fid}&target_fid=${castAdd.data.fid}&target_hash=${castHashHex}&reaction_type=${
          reaction.data?.reactionBody?.type || 0
        }`,
      );
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(protoToJSON(reaction, Message));

      // Make sure it also works with the string reaction type
      const url2 = getFullUrl(
        `/v1/reactionById?fid=${fid}&target_fid=${
          castAdd.data.fid
        }&target_hash=${castHashHex}&reaction_type=${reactionTypeToJSON(reaction.data?.reactionBody?.type || 0)}`,
      );
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data).toEqual(protoToJSON(reaction, Message));

      // Get the reaction by creator's fid
      const url3 = getFullUrl(`/v1/reactionsByFid?fid=${fid}&reaction_type=${reaction.data?.reactionBody?.type || 0}`);
      const response3 = await axiosGet(url3);

      expect(response3.status).toBe(200);
      expect(response3.data.messages).toEqual([protoToJSON(reaction, Message)]);

      // Get it by target cast
      const url4 = getFullUrl(
        `/v1/reactionsByCast?target_fid=${castAdd.data.fid}&target_hash=${castHashHex}&reaction_type=${
          reaction.data?.reactionBody?.type || 0
        }`,
      );
      const response4 = await axiosGet(url4);

      expect(response4.status).toBe(200);
      expect(response4.data.messages).toEqual([protoToJSON(reaction, Message)]);
    });

    test("getReactionByTargetURL", async () => {
      expect((await engine.mergeMessage(castAdd)).isOk()).toBeTruthy();

      const targetUrl = faker.internet.url();
      const reaction1 = await newReactionAdd({
        data: { reactionBody: { targetCastId: undefined, targetUrl, type: ReactionType.LIKE } },
      });
      const reaction2 = await newReactionAdd({
        data: { reactionBody: { targetCastId: undefined, targetUrl, type: ReactionType.RECAST } },
      });

      expect((await engine.mergeMessage(reaction1)).isOk()).toBeTruthy();
      expect((await engine.mergeMessage(reaction2)).isOk()).toBeTruthy();

      // Get a http client for port 2181
      const encoded = encodeURIComponent(targetUrl);
      const url = getFullUrl(`/v1/reactionsByTarget?url=${encoded}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data.messages).toEqual([protoToJSON(reaction1, Message), protoToJSON(reaction2, Message)]);

      // Make sure paging works
      const url4 = getFullUrl(`/v1/reactionsByTarget?url=${encoded}&pageSize=1`);
      const response4 = await axiosGet(url4);

      expect(response4.status).toBe(200);
      expect(response4.data.messages).toEqual([protoToJSON(reaction1, Message)]);

      // get the next page
      const url5 = getFullUrl(`/v1/reactionsByTarget?url=${encoded}&pageToken=${response4.data.nextPageToken}`);
      const response5 = await axiosGet(url5);

      expect(response5.status).toBe(200);
      expect(response5.data.messages).toEqual([protoToJSON(reaction2, Message)]);

      // Make sure reverse works
      const url3 = getFullUrl(`/v1/reactionsByTarget?url=${encoded}&reverse=true`);
      const response3 = await axiosGet(url3);

      expect(response3.status).toBe(200);
      expect(response3.data.messages).toEqual([protoToJSON(reaction2, Message), protoToJSON(reaction1, Message)]);
    });
  });

  describe("Link APIs", () => {
    let linkAdd: LinkAddMessage;
    const targetFid = Factories.Fid.build();

    beforeAll(async () => {
      linkAdd = await Factories.LinkAddMessage.create(
        { data: { fid, network, timestamp, linkBody: { targetFid, type: "follow" } } },
        { transient: { signer } },
      );
    });

    test("getLink", async () => {
      expect((await engine.mergeMessage(linkAdd)).isOk()).toBeTruthy();

      // Get a http client for port 2181
      const url = getFullUrl(
        `/v1/linkById?fid=${fid}&target_fid=${targetFid}&link_type=${linkAdd.data?.linkBody?.type}`,
      );
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(protoToJSON(linkAdd, Message));

      // Get it from the fid
      const url1 = getFullUrl(`/v1/linksByFid?fid=${fid}`);
      const response1 = await axiosGet(url1);

      expect(response1.status).toBe(200);
      expect(response1.data.messages).toEqual([protoToJSON(linkAdd, Message)]);

      // Get it by target fid
      const url2 = getFullUrl(`/v1/linksByTargetFid?target_fid=${targetFid}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data.messages).toEqual([protoToJSON(linkAdd, Message)]);
    });
  });

  describe("UserData APIs", () => {
    let addPfp: UserDataAddMessage;
    let addBio: UserDataAddMessage;

    beforeAll(async () => {
      addPfp = await Factories.UserDataAddMessage.create(
        { data: { fid, userDataBody: { type: UserDataType.PFP } } },
        { transient: { signer } },
      );
      addBio = await Factories.UserDataAddMessage.create(
        { data: { fid, userDataBody: { type: UserDataType.BIO }, timestamp: addPfp.data.timestamp + 1 } },
        { transient: { signer } },
      );
    });

    test("getUserData", async () => {
      expect((await engine.mergeMessage(addPfp)).isOk()).toBeTruthy();
      expect((await engine.mergeMessage(addBio)).isOk()).toBeTruthy();

      // Get it all
      const url = getFullUrl(`/v1/userDataByFid?fid=${fid}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data.messages).toEqual([protoToJSON(addPfp, Message), protoToJSON(addBio, Message)]);

      // Get it by type (pfp)
      const url2 = getFullUrl(`/v1/userDataByFid?fid=${fid}&user_data_type=${UserDataType.PFP}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data).toEqual(protoToJSON(addPfp, Message));

      // Get it by type (bio)
      const url3 = getFullUrl(`/v1/userDataByFid?fid=${fid}&user_data_type=${UserDataType.BIO}`);
      const response3 = await axiosGet(url3);

      expect(response3.status).toBe(200);
      expect(response3.data).toEqual(protoToJSON(addBio, Message));
    });
  });

  describe("Storage APIs", () => {
    test("getStorageLimits", async () => {
      const url = getFullUrl(`/v1/storageLimitsByFid?fid=${fid}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data.limits.length).toBeGreaterThan(0);
    });
  });

  describe("Username proofs", () => {
    let proof: UsernameProofMessage;
    const fname = "test.eth";

    beforeAll(async () => {
      const custodyAddress = bytesToHexString(custodyEvent.idRegisterEventBody.to)._unsafeUnwrap();
      jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
        return Promise.resolve(custodyAddress);
      });
      const timestampSec = Math.floor(Date.now() / 1000);
      proof = await Factories.UsernameProofMessage.create(
        {
          data: {
            fid,
            usernameProofBody: Factories.UserNameProof.build({
              name: utf8StringToBytes(fname)._unsafeUnwrap(),
              fid,
              owner: custodyEvent.idRegisterEventBody.to,
              timestamp: timestampSec,
              type: UserNameType.USERNAME_TYPE_ENS_L1,
            }),
            timestamp: toFarcasterTime(timestampSec * 1000)._unsafeUnwrap(),
            type: MessageType.USERNAME_PROOF,
          },
        },
        { transient: { signer } },
      );
    });

    test("getUsernameProof", async () => {
      expect((await engine.mergeMessage(proof)).isOk()).toBeTruthy();

      const url = getFullUrl(`/v1/userNameProofByName?name=${fname}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);

      expect(response.data).toEqual((protoToJSON(proof, Message) as UsernameProofMessage).data.usernameProofBody);

      // Get via fid
      const url2 = getFullUrl(`/v1/userNameProofsByFid?fid=${fid}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data.proofs).toEqual([
        (protoToJSON(proof, Message) as UsernameProofMessage).data.usernameProofBody,
      ]);
    });
  });

  describe("verification APIs", () => {
    let verificationAdd: VerificationAddEthAddressMessage;

    beforeAll(async () => {
      verificationAdd = await Factories.VerificationAddEthAddressMessage.create(
        { data: { fid, network } },
        { transient: { signer } },
      );
    });

    test("getVerification", async () => {
      expect((await engine.mergeMessage(verificationAdd)).isOk()).toBeTruthy();

      const address = verificationAdd.data.verificationAddEthAddressBody.address;
      const url = getFullUrl(`/v1/verificationsByFid?fid=${fid}&address=${bytesToHexString(address)._unsafeUnwrap()}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(protoToJSON(verificationAdd, Message));
      expect(response.data.data.verificationAddEthAddressBody.address).toEqual(
        bytesToHexString(address)._unsafeUnwrap(),
      );
      expect(response.data.data.verificationAddEthAddressBody.blockHash).toEqual(
        bytesToHexString(verificationAdd.data.verificationAddEthAddressBody.blockHash)._unsafeUnwrap(),
      );

      // Get via fid
      const url2 = getFullUrl(`/v1/verificationsByFid?fid=${fid}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data.messages).toEqual([protoToJSON(verificationAdd, Message)]);
    });
  });

  describe("onchain event APIs", () => {
    test("getOnChainEvent", async () => {
      const onChainEvent = Factories.SignerOnChainEvent.build();

      const fid = onChainEvent.fid;
      const signer = bytesToHexString(onChainEvent.signerEventBody.key)._unsafeUnwrap();
      const eventType = onChainEvent.type;

      expect(await engine.mergeOnChainEvent(onChainEvent)).toBeTruthy();

      const url = getFullUrl(`/v1/onChainSignersByFid?fid=${fid}&signer=${signer}`);
      const response = await axiosGet(url);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(protoToJSON(onChainEvent, OnChainEvent));

      // Get via fid
      const url2 = getFullUrl(`/v1/onChainSignersByFid?fid=${fid}`);
      const response2 = await axiosGet(url2);

      expect(response2.status).toBe(200);
      expect(response2.data.events).toEqual([protoToJSON(onChainEvent, OnChainEvent)]);

      // Get by type
      const url3 = getFullUrl(`/v1/onChainEventsByFid?fid=${fid}&event_type=${eventType}`);
      const response3 = await axiosGet(url3);

      expect(response3.status).toBe(200);
      expect(response3.data.events).toEqual([protoToJSON(onChainEvent, OnChainEvent)]);

      // Get by type name
      const url4 = getFullUrl(`/v1/onChainEventsByFid?fid=${fid}&event_type=${onChainEventTypeToJSON(eventType)}`);
      const response4 = await axiosGet(url4);

      expect(response4.status).toBe(200);
      expect(response4.data.events).toEqual([protoToJSON(onChainEvent, OnChainEvent)]);

      // Also do the IdRegistryEvent
      const idRegistryEvent = Factories.IdRegistryOnChainEvent.build({ fid });
      expect(await engine.mergeOnChainEvent(idRegistryEvent)).toBeTruthy();

      const url5 = getFullUrl(`/v1/onChainIdRegistryEventByAddress?address=${idRegistryEvent.idRegisterEventBody.to}`);
      const response5 = await axiosGet(url5);

      expect(response5.status).toBe(200);
      expect(response5.data).toEqual(protoToJSON(idRegistryEvent, OnChainEvent));
    });
  });
});

describe("connect API", () => {
  const signature =
    "0xc030c553eebcc41d9300dc578febe8ee41d69f86f13ecbbbc2e621583af8fb2b37e92009d1390d827ff22fdf255db2707773e04724252e3ab5c56cf1b7d2063e1b";
  const userDataSignature =
    "0xa5a5fbcf6d80862928f19a0b6ab2bdcb5f5d9febdafc4d759a99d417dfe58d9029739b29937fb0d78792b049db9602444133931153ea3b1e1fbcd69b50a5a0371c";

  beforeAll(async () => {
    httpServer = new HttpAPIServer(server.getImpl(), engine, publicClient);
    httpServerAddress = (await httpServer.start())._unsafeUnwrap();
  });

  test("valid message - 200", async () => {
    const res = connect.build({
      domain: "example.com",
      uri: "https://example.com/login",
      version: "1",
      nonce: "12345678",
      issuedAt: "2023-10-01T00:00:00.000Z",
      address: "0x2311B397957B19FCAe315Ad6726b7305BeBC24a1",
      fid: 20943,
    });
    const message = res._unsafeUnwrap();
    const url = getFullUrl("/v1/connect");
    const response = await axios.post(url, { message, signature }, { headers: { "Content-Type": "application/json" } });

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.fid).toBe(20943);
    expect(response.data.userDataParams).toBe(undefined);
    expect(response.data.userData).toBe(undefined);
  });

  test("valid message with userData - 200", async () => {
    const res = connect.build({
      domain: "example.com",
      uri: "https://example.com/login",
      version: "1",
      nonce: "12345678",
      issuedAt: "2023-10-01T00:00:00.000Z",
      address: "0x2311B397957B19FCAe315Ad6726b7305BeBC24a1",
      fid: 20943,
      userDataParams: ["pfp", "display", "username"],
    });
    const message = res._unsafeUnwrap();
    const url = getFullUrl("/v1/connect");
    const response = await axios.post(
      url,
      { message, signature: userDataSignature },
      { headers: { "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.fid).toBe(20943);
    expect(response.data.userDataParams).toStrictEqual(["pfp", "display", "username"]);
    expect(response.data.userData.messages).toStrictEqual([]);
  });

  test("invalid signature - 401", async () => {
    const res = connect.build({
      domain: "example.com",
      uri: "https://example.com/login",
      version: "1",
      nonce: "12345678",
      issuedAt: "2023-10-01T00:00:00.000Z",
      address: zeroAddress,
      fid: 20943,
    });
    const message = res._unsafeUnwrap();
    const url = getFullUrl("/v1/connect");
    const response = await axios.post(
      url,
      { message, signature },
      { validateStatus: () => true, headers: { "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(401);
    expect(response.data.error).toBe("unauthorized");
  });

  test("invalid message - 400", async () => {
    const message = {
      domain: "example.com",
      statement: "Farcaster Connect",
      chainId: 10,
      uri: "https://example.com/login",
      version: "1",
      nonce: "12345678",
      issuedAt: "2023-10-01T00:00:00.000Z",
      address: "0x123",
      resources: ["farcaster://fid/20943"],
    };
    const url = getFullUrl("/v1/connect");
    const response = await axios.post(
      url,
      { message, signature },
      { validateStatus: () => true, headers: { "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(400);
    expect(response.data.error).toBe("bad_request.validation_failure");
  });

  test("provider error - 503", async () => {
    jest.spyOn(publicClient, "readContract").mockRejectedValue(new Error("client error"));
    const res = connect.build({
      domain: "example.com",
      uri: "https://example.com/login",
      version: "1",
      nonce: "12345678",
      issuedAt: "2023-10-01T00:00:00.000Z",
      address: "0x2311B397957B19FCAe315Ad6726b7305BeBC24a1",
      fid: 20943,
    });
    const message = res._unsafeUnwrap();
    const url = getFullUrl("/v1/connect");
    const response = await axios.post(
      url,
      { message, signature },
      { validateStatus: () => true, headers: { "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(503);
    expect(response.data.error).toBe("unavailable.network_failure");
  });
});

async function axiosGet(url: string) {
  try {
    return await axios.get(url);
    // biome-ignore lint/suspicious/noExplicitAny: Catch axios errors
  } catch (error: any) {
    return { status: error?.response?.status, data: error?.response?.data };
  }
}
