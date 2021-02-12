# ODIN Claim Portal API
v0.1.0 -- Soft-Launch
---

## Dependencies

### GraphicsMagick
Used for compressing uploaded images to a lower filesize on the fly.

#### Debian/Ubuntu
```
apt-get install graphicsmagick
```

#### macOS
```
brew install graphicsmagick
```

### NodeJS
NodeJS 
[Install NodeJS - Ubuntu 16.04](https://www.digitalocean.com/community/tutorials/how-to-install-node-js-on-ubuntu-16-04)

### MongoDB
MongoDB is a free and open-source NoSQL document database and is used for storing user information.
[Install MongoDB - Ubuntu 16.04](https://www.digitalocean.com/community/tutorials/how-to-install-mongodb-on-ubuntu-16-04)

mongo --port <PORT>

#### Security
Recommended to change the default MongoDB Port to something custom. `/etc/mongodb.config`

### Redis
Redis is used for storing user sessions.
[Install Redis - Ubuntu 16.04](https://www.digitalocean.com/community/tutorials/how-to-install-and-configure-redis-on-ubuntu-16-04)

redis-cli -p <PORT>

## Development

### MongoDB
Start local MongoDB process using `./db` folder:
`mongod --logpath logs/mongod.log --dbpath db`

### Redis
Start local Redis process as daemon:
`redis-server &`

