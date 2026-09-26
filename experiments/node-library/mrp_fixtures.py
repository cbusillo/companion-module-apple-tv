"""Generate public synthetic MRP fixtures with the locked pyatv implementation.

Offline only. Print JSON to stdout; no discovery, credentials, or connections.
"""

import json
from typing import Any

from pyatv.protocols.airplay.channels import BaseDataStreamChannel, DataStreamMessage
from pyatv.protocols.mrp import protobuf as pb


def main() -> None:
    packets: dict[str, pb.ProtocolMessage] = {}

    def message(name: str, kind: int) -> Any:
        packet = pb.ProtocolMessage(type=kind)
        packets[name] = packet
        return pb.extract_inner(packet)

    device = message("device", pb.DEVICE_INFO_MESSAGE)
    device.name = "Synthetic TV"
    device.uniqueIdentifier = "tv-id"
    device.deviceUID = "tv-output"
    device.isGroupLeader = True
    device.isProxyGroupPlayer = False
    device.groupedDevices.add(name="Synthetic speaker", deviceUID="speaker-output")
    device.clusterID = "cluster-output"

    availability = message("availability", pb.VOLUME_CONTROL_AVAILABILITY_MESSAGE)
    availability.volumeControlAvailable = True
    availability.volumeCapabilities = pb.VolumeCapabilities.Both
    capability = message("capabilities", pb.VOLUME_CONTROL_CAPABILITIES_DID_CHANGE_MESSAGE)
    capability.capabilities.CopyFrom(availability)
    capability.outputDeviceUID = "cluster-output"
    volume = message("volume", pb.VOLUME_DID_CHANGE_MESSAGE)
    volume.volume = 0.3
    volume.outputDeviceUID = "cluster-output"

    client = message("client", pb.SET_NOW_PLAYING_CLIENT_MESSAGE)
    client.client.bundleIdentifier = "test.player"
    client.client.displayName = "Synthetic player"
    player = message("player", pb.SET_NOW_PLAYING_PLAYER_MESSAGE)
    player.playerPath.client.CopyFrom(client.client)
    player.playerPath.player.identifier = "main"

    state = message("state", pb.SET_STATE_MESSAGE)
    state.playerPath.CopyFrom(player.playerPath)
    state.playbackState = pb.PlaybackState.Playing
    state.playbackQueue.location = 0
    item = state.playbackQueue.contentItems.add(identifier="item-1")
    item.metadata.title = "Synthetic title"
    item.metadata.trackArtistName = "Synthetic artist"
    item.metadata.duration = 180
    item.metadata.elapsedTime = 12
    item.metadata.playbackRate = 1
    item.metadata.elapsedTimeTimestamp = 800000000

    update = message("content", pb.UPDATE_CONTENT_ITEM_MESSAGE)
    update.playerPath.CopyFrom(player.playerPath)
    update.contentItems.add(identifier="item-1").metadata.elapsedTime = 24
    remove_player = message("removePlayer", pb.REMOVE_PLAYER_MESSAGE)
    remove_player.playerPath.CopyFrom(player.playerPath)
    remove_client = message("removeClient", pb.REMOVE_CLIENT_MESSAGE)
    remove_client.client.CopyFrom(client.client)

    packets["ack"] = pb.ProtocolMessage(identifier="request-1")
    packets["error"] = pb.ProtocolMessage(identifier="request-2", errorCode=6, errorDescription="Synthetic rejection")
    batch = BaseDataStreamChannel.encode_message(DataStreamMessage(
        b"sync" + 8 * b"\0", b"comm", 0x123456789, 0,
        BaseDataStreamChannel.encode_payload({"params": {"data": BaseDataStreamChannel.encode_protobufs(list(packets.values()))}}),
    ))
    print(json.dumps({
        "source": "Locked pyatv protobuf and AirPlay DataStream encoders; all data synthetic",
        "messages": {name: packet.SerializeToString().hex() for name, packet in packets.items()},
        "batch": batch.hex(),
    }, indent=2))


if __name__ == "__main__":
    main()
