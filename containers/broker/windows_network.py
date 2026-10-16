"""Read-only Windows adapter inventory and tightly scoped route candidates.

Virtual adapter metadata only nominates a candidate. A fixed-image nonce/session
round-trip against the exact bound socket must prove Docker routing before use.
"""
import ipaddress
import os
import re
from protocol import require

def candidates(adapters):
    result=[{'bind':'127.0.0.1','connect':'host.docker.internal','adapterId':'loopback'}]
    for adapter in adapters:
        require(type(adapter) is dict and set(adapter)=={'id','name','description','type','status','addresses'},'INVALID_ADAPTER')
        if adapter['type']!=6 or adapter['status']!=1:continue
        if not re.fullmatch(r'vEthernet \((?:DockerNAT|WSL(?: \([^\r\n]{1,64}\))?)\)',adapter['name']):continue
        if not re.fullmatch(r'Hyper-V Virtual Ethernet Adapter(?: #[0-9]+)?',adapter['description']):continue
        require(type(adapter['id']) is str and 0<len(adapter['id'])<=256,'INVALID_ADAPTER')
        for address in adapter['addresses']:
            ip=ipaddress.ip_address(address)
            if ip.version!=4 or not ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:continue
            result.append({'bind':str(ip),'connect':str(ip),'adapterId':adapter['id']})
    require(len(result)<=8,'ADAPTER_LIMIT');return result

def windows_adapters():
    require(os.name=='nt','WINDOWS_REQUIRED')
    import ctypes as C
    from ctypes import wintypes as W
    class SocketAddress(C.Structure):_fields_=[('address',C.c_void_p),('length',C.c_int)]
    class Unicast(C.Structure):pass
    Unicast._fields_=[('alignment',C.c_ulonglong),('next',C.POINTER(Unicast)),('socket',SocketAddress)]
    class Adapter(C.Structure):pass
    Adapter._fields_=[('alignment',C.c_ulonglong),('next',C.POINTER(Adapter)),('id',C.c_char_p),('unicast',C.POINTER(Unicast)),('anycast',C.c_void_p),('multicast',C.c_void_p),('dns',C.c_void_p),('suffix',W.LPWSTR),('description',W.LPWSTR),('name',W.LPWSTR),('physical',C.c_ubyte*8),('physicalLength',W.DWORD),('flags',W.DWORD),('mtu',W.DWORD),('type',W.DWORD),('status',C.c_int)]
    api=C.WinDLL('iphlpapi',use_last_error=True);api.GetAdaptersAddresses.argtypes=[W.ULONG,W.ULONG,C.c_void_p,C.c_void_p,C.POINTER(W.ULONG)];api.GetAdaptersAddresses.restype=W.ULONG
    size=W.ULONG(15360)
    for attempt in range(3):
        require(size.value<=1024*1024,'ADAPTER_LIMIT');buffer=C.create_string_buffer(size.value)
        status=api.GetAdaptersAddresses(2,2|4|8,None,buffer,C.byref(size))
        if status!=111:break
    require(status==0,'ADAPTER_INVENTORY_UNAVAILABLE')
    rows=[];cursor=C.cast(buffer,C.POINTER(Adapter))
    while cursor:
        require(len(rows)<128,'ADAPTER_LIMIT');item=cursor.contents
        require((item.alignment&0xffffffff)>=C.sizeof(Adapter),'ADAPTER_LAYOUT_UNSUPPORTED')
        addresses=[];unicast=item.unicast
        while unicast:
            require(len(addresses)<64,'ADAPTER_LIMIT');address=unicast.contents.socket
            if address.length>=16:
                raw=C.string_at(address.address,16)
                if int.from_bytes(raw[:2],'little')==2:addresses.append(str(ipaddress.IPv4Address(raw[4:8])))
            unicast=unicast.contents.next
        rows.append({'id':item.id.decode('ascii'),'name':item.name or '', 'description':item.description or '', 'type':item.type,'status':item.status,'addresses':addresses});cursor=item.next
    return rows
