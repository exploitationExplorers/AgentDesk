#!/usr/bin/env python3
"""Create verified, encrypted logical backups; each database snapshot is independently consistent."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

def backup(root, keep):
    if os.name != 'posix' or os.geteuid() != 0:
        raise ValueError('Run as root on the deployment server')
    root = Path(root).resolve(strict=True)
    os.umask(0o077)
    public_key = root / 'secrets/backup-recovery.public.pem'
    if not public_key.is_file():
        raise ValueError('Install the backup RSA public key; keep its private key off the server')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    parent = root / 'backups'
    directory = parent / ('postgres-daily-' + stamp)
    directory.mkdir(mode=0o700)
    dump = directory / 'business.dump'
    with dump.open('wb') as stream:
        run(['docker','exec','agentdesk-postgres','pg_dump','-U','agentdesk_admin','-d','agentdesk',
             '-Fc','--schema=gateway','--schema=runner'], stdout=stream)
    verification = 'backup_verify_' + stamp.lower()
    run(['docker','exec','agentdesk-postgres','createdb','-U','agentdesk_admin',verification])
    try:
        with dump.open('rb') as stream:
            run(['docker','exec','-i','agentdesk-postgres','pg_restore','-U','agentdesk_admin','-d',verification,'--exit-on-error'],stdin=stream)
    finally:
        run(['docker','exec','agentdesk-postgres','dropdb','-U','agentdesk_admin',verification])
    # 保留 Runner 宿主配置与凭据的 SQLite 快照；云端业务记录由上面的 PostgreSQL dump 备份。
    temporary = '.daily-backup-' + stamp + '.sqlite'
    program = """const D=require('better-sqlite3');const d=new D('/data/agentdesk.db',{readonly:true,fileMustExist:true});
d.backup('/data/NAME').then(()=>{d.close();const b=new D('/data/NAME',{readonly:true});
if(b.pragma('integrity_check',{simple:true})!=='ok')throw Error('Runner backup integrity failed');b.close();})
.catch(()=>{console.error('Runner backup failed');process.exitCode=1});""".replace('NAME',temporary)
    run(['docker','exec','-i','agentdesk-cloud-runner-1','node','-'],input=program.encode())
    runner = directory / 'runner.sqlite'
    shutil.move(str(root/'data/runner'/temporary),str(runner))
    deployment = directory / 'deployment.tar'
    run(['tar','-cf',str(deployment),'-C',str(root),'deploy','config','secrets'])
    image = subprocess.check_output(['docker','inspect','agentdesk-cloud-gateway-1','--format','{{.Config.Image}}']).decode().strip()
    records = []
    for file in [dump, runner, deployment]:
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        run(['docker','run','--rm','--user','0:0','--network','none',
             '-v',str(directory)+':/backup','-v',str(public_key)+':/public.pem:ro',
             '-v',str(root/'ops/encrypt-backup.mjs')+':/encrypt.mjs:ro','--entrypoint','node',image,
             '/encrypt.mjs','/backup/'+file.name,'/public.pem'])
        records.append({'file':file.name+'.enc','plaintext_sha256':digest,'encrypted':True})
    manifest = {'timestamp':stamp,'verified':True,'postgres_restore_verified':True,'runner_integrity':'ok',
                'coordinated_snapshot':False,'files':records}
    (directory/'manifest.json').write_text(json.dumps(manifest,indent=2))
    # 仅轮换本脚本创建且完整验证的每日备份，保留所有迁移和人工备份。
    complete = []
    for path in parent.glob('postgres-daily-*'):
        if not path.is_dir() or path.is_symlink(): continue
        try:
            if json.loads((path/'manifest.json').read_text()).get('verified') is True: complete.append(path)
        except (OSError,ValueError): pass
    for path in sorted(complete,reverse=True)[keep:]:
        if path.resolve().parent != parent.resolve(): raise ValueError('Unsafe backup rotation path')
        shutil.rmtree(path)
    print(json.dumps({'backup':str(directory),'verified':True,'keep':keep}))

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',required=True)
    parser.add_argument('--keep',type=int,default=14)
    args=parser.parse_args()
    if args.keep < 2: parser.error('--keep must be at least 2')
    backup(args.root,args.keep)
